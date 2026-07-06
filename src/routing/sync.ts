/**
 * Routing sync (FR-9.1): builds a RoutingPolicy from an AgenticPerformance
 * eval export. APL stores eval runs in Postgres (`apl_eval_run` joined to
 * `apl_agent_version.model_snapshot_id`; task classes come from
 * `apl_eval_case.tags`) and ships no read API yet, so the interchange is a
 * JSON export — see docs/apl-eval-export.md for the exact SQL that produces
 * it. APL's load-bearing invariant is preserved: a class whose entries all
 * have total=0 is a hard error, never a green default.
 */

import { err, ok, type Result } from "neverthrow"
import { z } from "zod"

import { routingPolicySchema, type RoutingPolicy } from "./policy"

export const aplEvalExportSchema = z.object({
  evalRunId: z.string().min(1),
  exportedAt: z.string().optional(),
  entries: z
    .array(
      z.object({
        taskClass: z.string().min(1),
        provider: z.string().min(1),
        /** APL pins model snapshots, never floating aliases — keep that. */
        model: z.string().min(1),
        passRate: z.number().min(0).max(1),
        total: z.number().int().nonnegative(),
        costPerMTokIn: z.number().nonnegative().optional(),
        costPerMTokOut: z.number().nonnegative().optional(),
        latencyP50Ms: z.number().nonnegative().optional(),
        highRisk: z.boolean().optional(),
      }),
    )
    .min(1),
})

export type AplEvalExport = z.infer<typeof aplEvalExportSchema>

export const buildPolicyFromAplExport = (
  raw: unknown,
  now = new Date(),
): Result<RoutingPolicy, string> => {
  const parsed = aplEvalExportSchema.safeParse(raw)
  if (!parsed.success) {
    return err(`invalid APL eval export: ${parsed.error.issues[0]?.message ?? "parse error"}`)
  }
  const byClass = new Map<string, AplEvalExport["entries"]>()
  for (const entry of parsed.data.entries) {
    if (entry.total === 0) continue // an empty suite endorses nothing (APL gate: empty = fail)
    const list = byClass.get(entry.taskClass) ?? []
    list.push(entry)
    byClass.set(entry.taskClass, list)
  }
  if (byClass.size === 0) {
    return err("APL export contains no scored entries (all total=0) — refusing to build a policy")
  }
  const classes: RoutingPolicy["classes"] = {}
  for (const [taskClass, entries] of byClass) {
    const ranked = entries
      .toSorted(
        (a, b) =>
          b.passRate - a.passRate ||
          (a.costPerMTokOut ?? Number.MAX_VALUE) - (b.costPerMTokOut ?? Number.MAX_VALUE) ||
          (a.latencyP50Ms ?? Number.MAX_VALUE) - (b.latencyP50Ms ?? Number.MAX_VALUE),
      )
      .map((e) => ({
        provider: e.provider,
        model: e.model,
        passRate: e.passRate,
        ...(e.costPerMTokIn !== undefined ? { inputPerMTok: e.costPerMTokIn } : {}),
        ...(e.costPerMTokOut !== undefined ? { outputPerMTok: e.costPerMTokOut } : {}),
        ...(e.latencyP50Ms !== undefined ? { latencyP50Ms: e.latencyP50Ms } : {}),
      }))
    classes[taskClass] = {
      ranked,
      ...(entries.some((e) => e.highRisk === true) ? { highRisk: true } : {}),
    }
  }
  const classNames = Object.keys(classes).toSorted()
  const defaultClass = "default" in classes ? "default" : (classNames[0] as string)
  const policy: RoutingPolicy = {
    version: 1,
    source: { kind: "apl-eval", evalRunId: parsed.data.evalRunId, syncedAt: now.toISOString() },
    defaultClass,
    classes,
  }
  const validated = routingPolicySchema.safeParse(policy)
  if (!validated.success) return err("built policy failed validation")
  return ok(validated.data)
}
