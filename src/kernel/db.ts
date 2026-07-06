/**
 * Control-plane store — bun:sqlite, WAL, single file. Tenant-scoped tables per
 * the SRS data model. No raw prompts/payloads are ever stored here: the ledger
 * carries `input_hash` (sha256) only.
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  key_hash    TEXT NOT NULL UNIQUE,        -- sha256 of the client key; raw never stored
  label       TEXT,
  disabled    INTEGER NOT NULL DEFAULT 0,
  throttled   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_keys (  -- the vault
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  kind         TEXT NOT NULL DEFAULT 'bifrost_vk',
  secret_enc   TEXT NOT NULL,               -- AES-256-GCM blob; plaintext never stored
  active       INTEGER NOT NULL DEFAULT 1,
  rotated_from TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_keys_tenant_active
  ON provider_keys (tenant_id, active);

CREATE TABLE IF NOT EXISTS budgets (
  tenant_id     TEXT NOT NULL,
  scope         TEXT NOT NULL,              -- 'tenant' | 'run'
  scope_id      TEXT NOT NULL,              -- tenant id, or the run id
  limit_usd     REAL,
  limit_tokens  INTEGER,
  window_ms     INTEGER,                    -- NULL = lifetime (runs)
  window_start  INTEGER NOT NULL,
  spent_usd     REAL NOT NULL DEFAULT 0,
  spent_tokens  INTEGER NOT NULL DEFAULT 0,
  tripped       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, scope, scope_id)
);

CREATE TABLE IF NOT EXISTS request_ledger (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  key_id               TEXT NOT NULL,
  run_id               TEXT,
  task_class           TEXT,
  model                TEXT NOT NULL,       -- as requested by the client
  route                TEXT,                -- provider/model that actually served it
  input_hash           TEXT NOT NULL,       -- sha256 of message contents; never raw
  outcome              TEXT NOT NULL,
  guard_tags           TEXT,                -- JSON array of tags, never offending text
  protected_path_flag  INTEGER NOT NULL DEFAULT 0,
  cache_hit            INTEGER NOT NULL DEFAULT 0,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cost_usd             REAL,
  latency_ms           REAL,
  judge_verdict        TEXT,                -- 'pass' | 'fail' when sampled
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_tenant_time ON request_ledger (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_key_time    ON request_ledger (key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS routing_policies (
  tenant_id    TEXT NOT NULL DEFAULT '*',   -- '*' = the default policy
  doc          TEXT NOT NULL,               -- RoutingPolicy JSON
  eval_run_id  TEXT,                        -- source AgenticPerformance eval run
  synced_at    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id)
);
`

export const openDb = (path: string): Database => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  // the edge and the CLI share one file — wait out a concurrent writer's lock
  // instead of throwing SQLITE_BUSY into the hot path or the async lane.
  db.exec("PRAGMA busy_timeout = 5000;")
  db.exec(SCHEMA)
  return db
}
