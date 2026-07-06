/**
 * One-key auth (FR-1.1/1.4). Tenant + identity derive from the presented key —
 * never from model output. O(1): sha256 of the bearer + one indexed lookup on
 * a prepared statement. Missing/unknown/disabled keys fail closed.
 */

import type { Database } from "bun:sqlite"

import { err, ok, type Result } from "neverthrow"

import { sha256hex } from "../kernel/crypto"

export interface Principal {
  tenantId: string
  tenantName: string
  keyId: string
}

export interface AuthDenial {
  status: number
  code: string
}

export type Authenticator = (authorizationHeader: string | null) => Result<Principal, AuthDenial>

export const makeAuthenticator = (db: Database): Authenticator => {
  const stmt = db.query<
    { key_id: string; tenant_id: string; tenant_name: string; throttled: number },
    [string]
  >(
    `SELECT k.id AS key_id, t.id AS tenant_id, t.name AS tenant_name, k.throttled
     FROM gateway_keys k JOIN tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = ? AND k.disabled = 0`,
  )
  return (header) => {
    if (header === null || !header.startsWith("Bearer ")) {
      return err({ status: 401, code: "missing_key" })
    }
    const token = header.slice("Bearer ".length).trim()
    if (token.length === 0) return err({ status: 401, code: "missing_key" })
    const row = stmt.get(sha256hex(token))
    if (row === null) return err({ status: 401, code: "unknown_key" })
    if (row.throttled === 1) return err({ status: 429, code: "key_throttled" })
    return ok({ tenantId: row.tenant_id, tenantName: row.tenant_name, keyId: row.key_id })
  }
}
