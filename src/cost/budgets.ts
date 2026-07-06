/**
 * Cost ceilings in code (FR-9.3, Scorecard Cost M2). Two scopes:
 *   - tenant: windowed (e.g. monthly) USD/token ceiling; lazily reset when the
 *     window rolls over. A tenant WITHOUT a budget row is denied — fail-closed;
 *     `tenant create` always provisions one.
 *   - run: lifetime ceiling per `x-agw-run-id`, auto-provisioned at the
 *     configured default — the circuit breaker that halts a runaway session.
 * Checks are prepared-statement reads on the hot path; spend lands in the
 * async lane and trips the breaker for subsequent calls.
 */

import type { Database } from "bun:sqlite"

import { err, ok, type Result } from "neverthrow"

export interface BudgetLimits {
  limitUsd?: number
  limitTokens?: number
  windowMs?: number
}

export interface BudgetDenial {
  scope: "tenant" | "run"
  code: "budget_missing" | "budget_exceeded"
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000

export const ensureTenantBudget = (db: Database, tenantId: string, limits: BudgetLimits): void => {
  db.query(
    `INSERT INTO budgets (tenant_id, scope, scope_id, limit_usd, limit_tokens, window_ms, window_start)
     VALUES (?, 'tenant', ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, scope, scope_id) DO UPDATE SET
       limit_usd = excluded.limit_usd,
       limit_tokens = excluded.limit_tokens,
       window_ms = excluded.window_ms,
       tripped = 0`,
  ).run(
    tenantId,
    tenantId,
    limits.limitUsd ?? null,
    limits.limitTokens ?? null,
    limits.windowMs ?? MONTH_MS,
    Date.now(),
  )
}

interface BudgetRow {
  limit_usd: number | null
  limit_tokens: number | null
  window_ms: number | null
  window_start: number
  spent_usd: number
  spent_tokens: number
  tripped: number
}

const overLimit = (row: BudgetRow): boolean =>
  row.tripped === 1 ||
  (row.limit_usd !== null && row.spent_usd >= row.limit_usd) ||
  (row.limit_tokens !== null && row.spent_tokens >= row.limit_tokens)

/**
 * Hot-path gate. Missing tenant budget denies (fail-closed); an expired
 * window resets lazily; a run id is auto-provisioned with the default
 * per-run ceiling on first sight.
 */
export const checkBudgets = (
  db: Database,
  tenantId: string,
  runId: string | null,
  defaultRunLimitUsd: number,
  now = Date.now(),
): Result<void, BudgetDenial> => {
  const tenant = db
    .query<BudgetRow, [string, string]>(
      "SELECT limit_usd, limit_tokens, window_ms, window_start, spent_usd, spent_tokens, tripped FROM budgets WHERE tenant_id = ? AND scope = 'tenant' AND scope_id = ?",
    )
    .get(tenantId, tenantId)
  if (tenant === null) return err({ scope: "tenant", code: "budget_missing" })
  let effective = tenant
  if (tenant.window_ms !== null && now - tenant.window_start >= tenant.window_ms) {
    db.query(
      "UPDATE budgets SET window_start = ?, spent_usd = 0, spent_tokens = 0, tripped = 0 WHERE tenant_id = ? AND scope = 'tenant' AND scope_id = ?",
    ).run(now, tenantId, tenantId)
    effective = { ...tenant, window_start: now, spent_usd: 0, spent_tokens: 0, tripped: 0 }
  }
  if (overLimit(effective)) return err({ scope: "tenant", code: "budget_exceeded" })

  if (runId !== null) {
    const run = db
      .query<BudgetRow, [string, string]>(
        "SELECT limit_usd, limit_tokens, window_ms, window_start, spent_usd, spent_tokens, tripped FROM budgets WHERE tenant_id = ? AND scope = 'run' AND scope_id = ?",
      )
      .get(tenantId, runId)
    if (run === null) {
      db.query(
        "INSERT OR IGNORE INTO budgets (tenant_id, scope, scope_id, limit_usd, window_ms, window_start) VALUES (?, 'run', ?, ?, NULL, ?)",
      ).run(tenantId, runId, defaultRunLimitUsd, now)
    } else if (overLimit(run)) {
      return err({ scope: "run", code: "budget_exceeded" })
    }
  }
  return ok(undefined)
}

/** Async-lane spend recording; trips the breaker the moment a ceiling is crossed. */
export const recordSpend = (
  db: Database,
  tenantId: string,
  runId: string | null,
  tokens: number,
  usd: number,
): void => {
  const trip = `
    UPDATE budgets SET
      spent_usd = spent_usd + ?,
      spent_tokens = spent_tokens + ?,
      tripped = CASE WHEN
        (limit_usd IS NOT NULL AND spent_usd + ? >= limit_usd) OR
        (limit_tokens IS NOT NULL AND spent_tokens + ? >= limit_tokens)
      THEN 1 ELSE tripped END
    WHERE tenant_id = ? AND scope = ? AND scope_id = ?`
  db.query(trip).run(usd, tokens, usd, tokens, tenantId, "tenant", tenantId)
  if (runId !== null) db.query(trip).run(usd, tokens, usd, tokens, tenantId, "run", runId)
}
