/**
 * Sampled judge (FR-D.2 / T6.3) — delegation to AgenticPerformance. The judge
 * logic is APL's own `runJudge`, vendored byte-for-byte; this module only
 * decides WHEN to invoke it (deterministic hash sampling on high-risk routes,
 * never the hot path) and supplies an AplChat that routes through Bifrost —
 * the gateway never calls a provider directly, even to judge itself.
 */

import { runJudge, type AplChat } from "../../vendor/apl/judge"
import { hashUnit } from "../../vendor/apl/sampling"

/** Deterministic per-request sampling (APL's split primitive, same behavior). */
export const shouldJudge = (requestId: string, highRisk: boolean, sampleRate: number): boolean =>
  sampleRate > 0 && highRisk && hashUnit(requestId) < sampleRate

export type JudgeCaller = (args: {
  requestId: string
  /** The item put in front of the judge (response text, truncated by caller). */
  itemText: string
  /** Tenant's vaulted upstream credential, when Bifrost governance is on. */
  vkSecret: string | null
}) => Promise<"pass" | "fail">

export const makeJudgeCaller = (opts: {
  bifrostUrl: string
  model: string
  fetchImpl?: typeof fetch
}): JudgeCaller => {
  const fetchImpl = opts.fetchImpl ?? fetch
  return async ({ requestId, itemText, vkSecret }) => {
    const chat: AplChat = async ({ prompt, system, model }) => {
      const res = await fetchImpl(`${opts.bifrostUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(vkSecret === null ? {} : { authorization: `Bearer ${vkSecret}` }),
        },
        body: JSON.stringify({
          model: model ?? opts.model,
          messages: [
            ...(system === undefined ? [] : [{ role: "system", content: system }]),
            { role: "user", content: prompt },
          ],
        }),
      })
      if (!res.ok) throw new Error(`judge upstream ${res.status}`)
      const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== "string") throw new Error("judge upstream returned no text")
      return content
    }
    // runJudge maps a thrown chat to got=false — an erroring judge has NOT endorsed.
    const [verdict] = await runJudge(
      [{ id: requestId, input: itemText, expected: true }],
      chat,
      { model: opts.model },
    )
    return verdict !== undefined && verdict.got ? "pass" : "fail"
  }
}
