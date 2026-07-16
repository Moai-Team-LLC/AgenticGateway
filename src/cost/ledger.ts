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
  /** Cache-adjusted $ (honest under provider prompt caching). */
  costUsd: number | null
  /** Provider prompt-cache read/write tokens (absent when the provider omits the split). */
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  /** 1 − cache-adjusted/nominal cost — how much prompt caching saved this call. */
  cacheSavingsRatio?: number | null
  latencyMs: number
}

export const recordLedger = (db: Database, e: LedgerEntry): void => {
  db.query(
    `INSERT INTO request_ledger
       (id, tenant_id, key_id, run_id, task_class, model, route, input_hash, outcome,
        guard_tags, protected_path_flag, cache_hit, input_tokens, output_tokens,
        cost_usd, latency_ms, cache_read_tokens, cache_write_tokens, cache_savings_ratio,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    e.cacheReadTokens ?? null,
    e.cacheWriteTokens ?? null,
    e.cacheSavingsRatio ?? null,
    Date.now(),
  )
}

export const setJudgeVerdict = (db: Database, requestId: string, verdict: "pass" | "fail"): void => {
  db.query("UPDATE request_ledger SET judge_verdict = ? WHERE id = ?").run(verdict, requestId)
}

export interface CostPerVerified {
  /** Verified outcomes (judge_verdict = 'pass') in the window. */
  verifiedOutcomes: number
  /** Total cache-adjusted $ over ALL metered calls in the window (a failed verify still cost). */
  totalCostUsd: number
  /** $ per verify-passing outcome = totalCost / verified. null when nothing verified. */
  costPerVerifiedUsd: number | null
}

/**
 * The platform's headline cost/quality-plane number (doctrine §5): cache-adjusted spend per
 * verify-passing outcome, joined from the same ledger row (cost_usd + judge_verdict already
 * co-located). A rising value = burning more to confirm less — the earliest degradation
 * signal. Costs are already cache-adjusted so this is honest under prompt caching. Only
 * judge-SAMPLED calls carry a verdict, so it is a sampled estimate. Optionally tenant/windowed.
 */
export const costPerVerifiedOutcome = (
  db: Database,
  opts: { tenantId?: string; sinceMs?: number } = {},
): CostPerVerified => {
  const where: string[] = ["cost_usd IS NOT NULL"]
  const params: (string | number)[] = []
  if (opts.tenantId !== undefined) {
    where.push("tenant_id = ?")
    params.push(opts.tenantId)
  }
  if (opts.sinceMs !== undefined) {
    where.push("created_at >= ?")
    params.push(opts.sinceMs)
  }
  const row = db
    .query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost,
              SUM(CASE WHEN judge_verdict = 'pass' THEN 1 ELSE 0 END) AS verified
       FROM request_ledger WHERE ${where.join(" AND ")}`,
    )
    .get(...params) as { total_cost: number; verified: number | null }
  const verifiedOutcomes = row.verified ?? 0
  return {
    verifiedOutcomes,
    totalCostUsd: row.total_cost,
    costPerVerifiedUsd: verifiedOutcomes > 0 ? row.total_cost / verifiedOutcomes : null,
  }
}
