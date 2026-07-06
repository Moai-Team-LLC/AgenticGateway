/**
 * Spend anomaly detection (FR-9.5): deterministic, ledger-driven, per key.
 * "Anomalous" = the last 5 minutes of spend exceed the trailing hour's
 * per-5-minute average by the configured factor (default 5×), with floors so
 * quiet keys don't alert on noise. Runs in the async lane; optionally
 * throttles the offending key (auth then denies with 429).
 */

import type { Database } from "bun:sqlite"

const WINDOW_MS = 5 * 60 * 1000
const BASELINE_MS = 60 * 60 * 1000
/** Below this recent spend we never alert (noise floor). */
const MIN_RECENT_USD = 0.25
/** A key with no history must burn at least this much in 5 min to alert. */
const COLD_FLOOR_USD = 1

export interface AnomalyVerdict {
  anomalous: boolean
  recentUsd: number
  baselinePer5mUsd: number
}

export const checkSpendAnomaly = (
  db: Database,
  keyId: string,
  factor: number,
  now = Date.now(),
): AnomalyVerdict => {
  const recent =
    db
      .query<{ usd: number | null }, [string, number]>(
        "SELECT SUM(cost_usd) AS usd FROM request_ledger WHERE key_id = ? AND created_at > ?",
      )
      .get(keyId, now - WINDOW_MS)?.usd ?? 0
  const baseline =
    db
      .query<{ usd: number | null }, [string, number, number]>(
        "SELECT SUM(cost_usd) AS usd FROM request_ledger WHERE key_id = ? AND created_at > ? AND created_at <= ?",
      )
      .get(keyId, now - BASELINE_MS, now - WINDOW_MS)?.usd ?? 0
  const baselinePer5m = baseline / ((BASELINE_MS - WINDOW_MS) / WINDOW_MS)
  const anomalous =
    recent >= MIN_RECENT_USD &&
    (baselinePer5m === 0 ? recent >= COLD_FLOOR_USD : recent > baselinePer5m * factor)
  return { anomalous, recentUsd: recent, baselinePer5mUsd: baselinePer5m }
}

export const throttleKey = (db: Database, keyId: string): void => {
  db.query("UPDATE gateway_keys SET throttled = 1 WHERE id = ?").run(keyId)
}

export const unthrottleKey = (db: Database, keyId: string): void => {
  db.query("UPDATE gateway_keys SET throttled = 0 WHERE id = ?").run(keyId)
}
