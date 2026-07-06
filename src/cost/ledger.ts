/**
 * Request ledger (SRS §5): one row per call — tenant, route, tokens, cost,
 * latency, cache-hit, outcome, and `input_hash` (sha256). Raw prompts and
 * payloads never land here; this table feeds cost-per-outcome and anomaly
 * detection.
 */

import type { Database } from "bun:sqlite"

export interface LedgerEntry {
  id: string
  tenantId: string
  keyId: string
  runId: string | null
  taskClass: string | null
  model: string
  route: string | null
  inputHash: string
  outcome:
    | "ok"
    | "cache_hit"
    | "client_aborted"
    | "denied_guard"
    | "denied_budget"
    | "denied_policy"
    | "denied_vault"
    | "denied_output"
    | "upstream_error"
  guardTags: string[]
  protectedPathFlag: boolean
  cacheHit: boolean
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  latencyMs: number
}

export const recordLedger = (db: Database, e: LedgerEntry): void => {
  db.query(
    `INSERT INTO request_ledger
       (id, tenant_id, key_id, run_id, task_class, model, route, input_hash, outcome,
        guard_tags, protected_path_flag, cache_hit, input_tokens, output_tokens,
        cost_usd, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.tenantId,
    e.keyId,
    e.runId,
    e.taskClass,
    e.model,
    e.route,
    e.inputHash,
    e.outcome,
    JSON.stringify(e.guardTags),
    e.protectedPathFlag ? 1 : 0,
    e.cacheHit ? 1 : 0,
    e.inputTokens,
    e.outputTokens,
    e.costUsd,
    e.latencyMs,
    Date.now(),
  )
}

export const setJudgeVerdict = (db: Database, requestId: string, verdict: "pass" | "fail"): void => {
  db.query("UPDATE request_ledger SET judge_verdict = ? WHERE id = ?").run(verdict, requestId)
}
