/**
 * Evidence emitter (FR-D.3) — one hash-not-text event per gateway decision,
 * AIUC-1 lane. Wire shape follows the AgenticMind `POST /hooks/audit`
 * contract (an `event` kind + session/tool/decision; the sink hashes the
 * whole payload server-side). Sinks: `http` (the shared AgenticMind sink
 * AgenticAssurance uses), `file` (local JSONL — the OSS default, so evidence
 * exists without any sibling running), `off`. Best-effort by family design:
 * evidence failure never blocks or fails a request — but it is counted.
 */

import { appendFile } from "node:fs/promises"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import type { Config } from "../kernel/config"

/** Typed shape: there is deliberately no field for raw text/payloads. */
export interface EvidenceEvent {
  event:
    | "GatewayRequest"
    | "GuardBlock"
    | "OutputLeak"
    | "ProtectedPathFlag"
    | "SpendAnomaly"
    | "JudgeVerdict"
    | "CliMutation"
  session_id: string | null
  tool: string
  decision: "allow" | "deny" | "flag"
  tenant_id?: string
  input_hash?: string
  route?: string
  outcome?: string
  reason?: string
  tags?: string[]
  tokens?: number
  cost_usd?: number
  cache_hit?: boolean
}

export interface EvidenceEmitter {
  emit(event: EvidenceEvent): void
  flush(): Promise<void>
  readonly dropped: number
}

export const makeEvidenceEmitter = (
  cfg: Pick<Config, "evidenceSink" | "evidenceFile" | "auditUrl" | "auditToken">,
  fetchImpl: typeof fetch = fetch,
): EvidenceEmitter => {
  if (cfg.evidenceSink === "off") {
    return { emit: () => undefined, flush: async () => undefined, dropped: 0 }
  }

  let dropped = 0
  let chain: Promise<void> = Promise.resolve()

  const writeFile = (line: string): void => {
    chain = chain
      .then(() => appendFile(cfg.evidenceFile, line))
      .catch(() => {
        dropped += 1
      })
  }

  const postHttp = (body: string): void => {
    const url = cfg.auditUrl as string // config load enforces presence for http sink
    chain = chain
      .then(async () => {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(cfg.auditToken === undefined ? {} : { authorization: `Bearer ${cfg.auditToken}` }),
          },
          body,
        })
        if (!res.ok) dropped += 1
      })
      .catch(() => {
        dropped += 1
      })
  }

  if (cfg.evidenceSink === "file") {
    mkdirSync(dirname(cfg.evidenceFile), { recursive: true })
  }

  return {
    emit(event) {
      const enriched = { ...event, ts: new Date().toISOString(), source: "agentic-gateway" }
      const json = JSON.stringify(enriched)
      if (cfg.evidenceSink === "file") writeFile(`${json}\n`)
      else postHttp(json)
    },
    async flush() {
      await chain
    },
    get dropped() {
      return dropped
    },
  }
}
