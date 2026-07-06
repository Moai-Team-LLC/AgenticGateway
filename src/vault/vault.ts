/**
 * Provider-key vault (FR-1.3). One client key → a tenant → a vaulted upstream
 * credential (a Bifrost virtual key, `sk-bf-*`), encrypted at rest with
 * AES-256-GCM. Client keys are stored as sha256 only; upstream secrets never
 * appear in client responses, errors, logs, or evidence. Rotation inserts a
 * new active row and retires the old one — no client-side change.
 */

import type { Database } from "bun:sqlite"

import { err, ok, type Result } from "neverthrow"

import { decryptSecret, encryptSecret, newClientKey, newUuid, sha256hex } from "../kernel/crypto"

export interface CreatedTenant {
  tenantId: string
  keyId: string
  /** Shown once at creation; only its hash is stored. */
  clientKey: string
}

export const createTenant = (db: Database, name: string): Result<CreatedTenant, string> => {
  const existing = db.query("SELECT id FROM tenants WHERE name = ?").get(name)
  if (existing !== null) return err(`tenant "${name}" already exists`)
  const tenantId = newUuid()
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)").run(tenantId, name, Date.now())
  const issued = issueKey(db, tenantId, "initial")
  if (issued.isErr()) return err(issued.error)
  return ok({ tenantId, ...issued.value })
}

export const findTenantByName = (db: Database, name: string): { id: string; name: string } | null =>
  db.query<{ id: string; name: string }, [string]>("SELECT id, name FROM tenants WHERE name = ?").get(name)

export const issueKey = (
  db: Database,
  tenantId: string,
  label?: string,
): Result<{ keyId: string; clientKey: string }, string> => {
  const tenant = db.query("SELECT id FROM tenants WHERE id = ?").get(tenantId)
  if (tenant === null) return err("unknown tenant")
  const clientKey = newClientKey()
  const keyId = newUuid()
  db.query(
    "INSERT INTO gateway_keys (id, tenant_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(keyId, tenantId, sha256hex(clientKey), label ?? null, Date.now())
  return ok({ keyId, clientKey })
}

export const revokeKey = (db: Database, keyId: string): Result<void, string> => {
  const res = db.query("UPDATE gateway_keys SET disabled = 1 WHERE id = ?").run(keyId)
  return res.changes === 0 ? err("unknown key id") : ok(undefined)
}

/**
 * Stores (or rotates) the tenant's upstream credential. The previous active
 * row is retired but kept for audit; `rotated_from` links the chain.
 */
export const setUpstreamSecret = (
  db: Database,
  vaultKey: string,
  tenantId: string,
  secret: string,
): Result<{ rotated: boolean }, string> => {
  const tenant = db.query("SELECT id FROM tenants WHERE id = ?").get(tenantId)
  if (tenant === null) return err("unknown tenant")
  const enc = encryptSecret(secret, vaultKey)
  if (enc.isErr()) return err(enc.error)
  const prev = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM provider_keys WHERE tenant_id = ? AND active = 1",
    )
    .get(tenantId)
  db.query("UPDATE provider_keys SET active = 0 WHERE tenant_id = ? AND active = 1").run(tenantId)
  db.query(
    "INSERT INTO provider_keys (id, tenant_id, secret_enc, active, rotated_from, created_at) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(newUuid(), tenantId, enc.value, prev?.id ?? null, Date.now())
  return ok({ rotated: prev !== null })
}

export type VaultReader = (tenantId: string) => Result<string | null, string>

/**
 * Hot-path reader: decrypts the tenant's active upstream secret with a small
 * in-memory TTL cache so the steady state is a Map lookup, not AES work.
 * Returns ok(null) when the tenant has no vaulted credential.
 */
export const makeVaultReader = (
  db: Database,
  vaultKey: string | undefined,
  ttlMs = 60_000,
): VaultReader => {
  const cache = new Map<string, { secret: string | null; at: number }>()
  const stmt = db.query<{ secret_enc: string }, [string]>(
    "SELECT secret_enc FROM provider_keys WHERE tenant_id = ? AND active = 1",
  )
  return (tenantId) => {
    const hit = cache.get(tenantId)
    if (hit !== undefined && Date.now() - hit.at < ttlMs) return ok(hit.secret)
    const row = stmt.get(tenantId)
    if (row === null) {
      cache.set(tenantId, { secret: null, at: Date.now() })
      return ok(null)
    }
    if (vaultKey === undefined) return err("vault key not configured but a vaulted credential exists")
    const dec = decryptSecret(row.secret_enc, vaultKey)
    if (dec.isErr()) return err(dec.error)
    cache.set(tenantId, { secret: dec.value, at: Date.now() })
    return ok(dec.value)
  }
}
