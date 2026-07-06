import { describe, expect, test } from "bun:test"

import { decryptSecret, encryptSecret } from "../src/kernel/crypto"
import { openDb } from "../src/kernel/db"
import { createTenant, issueKey, makeVaultReader, revokeKey, setUpstreamSecret } from "../src/vault/vault"
import { TEST_VAULT_KEY } from "./helpers"

describe("kernel/crypto AES-GCM", () => {
  test("roundtrips", () => {
    const blob = encryptSecret("sk-bf-super-secret", TEST_VAULT_KEY)._unsafeUnwrap()
    expect(blob).not.toContain("sk-bf-super-secret")
    expect(decryptSecret(blob, TEST_VAULT_KEY)._unsafeUnwrap()).toBe("sk-bf-super-secret")
  })

  test("wrong key fails closed", () => {
    const blob = encryptSecret("sk-bf-super-secret", TEST_VAULT_KEY)._unsafeUnwrap()
    expect(decryptSecret(blob, "0".repeat(64)).isErr()).toBe(true)
  })

  test("rejects malformed keys and blobs", () => {
    expect(encryptSecret("x", "short").isErr()).toBe(true)
    expect(decryptSecret("not-a-blob", TEST_VAULT_KEY).isErr()).toBe(true)
  })
})

describe("vault", () => {
  test("tenant creation issues a client key and stores only its hash", () => {
    const db = openDb(":memory:")
    const created = createTenant(db, "acme")._unsafeUnwrap()
    expect(created.clientKey.startsWith("sk-agw-")).toBe(true)
    const rows = db.query("SELECT key_hash FROM gateway_keys").all() as { key_hash: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key_hash).not.toContain(created.clientKey)
    expect(rows[0]?.key_hash).toHaveLength(64)
  })

  test("duplicate tenant name is refused", () => {
    const db = openDb(":memory:")
    createTenant(db, "acme")._unsafeUnwrap()
    expect(createTenant(db, "acme").isErr()).toBe(true)
  })

  test("upstream secret is encrypted at rest and readable via the reader", () => {
    const db = openDb(":memory:")
    const { tenantId } = createTenant(db, "acme")._unsafeUnwrap()
    setUpstreamSecret(db, TEST_VAULT_KEY, tenantId, "sk-bf-upstream-1")._unsafeUnwrap()
    const raw = db.query("SELECT secret_enc FROM provider_keys").all() as { secret_enc: string }[]
    expect(raw[0]?.secret_enc).not.toContain("sk-bf-upstream-1")
    const read = makeVaultReader(db, TEST_VAULT_KEY, 0)
    expect(read(tenantId)._unsafeUnwrap()).toBe("sk-bf-upstream-1")
  })

  test("rotation swaps the secret with no client-key change", () => {
    const db = openDb(":memory:")
    const created = createTenant(db, "acme")._unsafeUnwrap()
    setUpstreamSecret(db, TEST_VAULT_KEY, created.tenantId, "sk-bf-old")._unsafeUnwrap()
    const rotated = setUpstreamSecret(db, TEST_VAULT_KEY, created.tenantId, "sk-bf-new")._unsafeUnwrap()
    expect(rotated.rotated).toBe(true)
    const read = makeVaultReader(db, TEST_VAULT_KEY, 0)
    expect(read(created.tenantId)._unsafeUnwrap()).toBe("sk-bf-new")
    // the retired credential is kept for audit, inactive
    const rows = db.query("SELECT active FROM provider_keys ORDER BY created_at").all() as { active: number }[]
    expect(rows.map((r) => r.active)).toEqual([0, 1])
    // client key unchanged
    const keys = db.query("SELECT id FROM gateway_keys").all()
    expect(keys).toHaveLength(1)
  })

  test("reader without a configured vault key fails closed when a secret exists", () => {
    const db = openDb(":memory:")
    const { tenantId } = createTenant(db, "acme")._unsafeUnwrap()
    setUpstreamSecret(db, TEST_VAULT_KEY, tenantId, "sk-bf-x")._unsafeUnwrap()
    const read = makeVaultReader(db, undefined, 0)
    expect(read(tenantId).isErr()).toBe(true)
  })

  test("issue + revoke key lifecycle", () => {
    const db = openDb(":memory:")
    const { tenantId } = createTenant(db, "acme")._unsafeUnwrap()
    const extra = issueKey(db, tenantId, "ci")._unsafeUnwrap()
    expect(revokeKey(db, extra.keyId).isOk()).toBe(true)
    expect(revokeKey(db, "nope").isErr()).toBe(true)
  })
})
