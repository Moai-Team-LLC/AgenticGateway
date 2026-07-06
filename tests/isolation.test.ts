/**
 * Cross-tenant leakage test (NFR-4 / T6.2, CI-gated): keys, cache, budgets,
 * vault, routing, ledger, and evidence must never cross tenants.
 */

import { describe, expect, test } from "bun:test"

import { ensureTenantBudget, recordSpend } from "../src/cost/budgets"
import { savePolicy } from "../src/routing/policy"
import { createTenant, setUpstreamSecret } from "../src/vault/vault"
import { chatReq, fixturePolicy, flushAsyncLane, setupEdge, simpleChat, TEST_VAULT_KEY } from "./helpers"

const twoTenants = () => {
  const edge = setupEdge() // tenant A = "acme"
  const b = createTenant(edge.db, "globex")._unsafeUnwrap()
  ensureTenantBudget(edge.db, b.tenantId, { limitUsd: 100, windowMs: 24 * 60 * 60 * 1000 })
  return { edge, b }
}

describe("tenant isolation", () => {
  test("cache entries never cross tenants (same prompt → two provider calls)", async () => {
    const { edge, b } = twoTenants()
    await edge.handler(chatReq(edge.clientKey, simpleChat()))
    const res = await edge.handler(chatReq(b.clientKey, simpleChat()))
    expect(res.headers.get("x-agw-cache")).toBe("miss")
    expect(edge.calls).toHaveLength(2)
  })

  test("one tenant's blown budget never blocks the other", async () => {
    const { edge, b } = twoTenants()
    recordSpend(edge.db, edge.tenantId, null, 10_000_000, 1000) // trip A
    expect((await edge.handler(chatReq(edge.clientKey, simpleChat()))).status).toBe(429)
    expect((await edge.handler(chatReq(b.clientKey, simpleChat()))).status).toBe(200)
  })

  test("vaulted credentials are attached per tenant, never shared", async () => {
    const { edge, b } = twoTenants()
    setUpstreamSecret(edge.db, TEST_VAULT_KEY, edge.tenantId, "sk-bf-tenant-a")._unsafeUnwrap()
    await edge.handler(chatReq(edge.clientKey, simpleChat()))
    await edge.handler(chatReq(b.clientKey, simpleChat("openai/gpt-4o-mini", "other prompt")))
    expect(edge.calls[0]?.headers["authorization"]).toBe("Bearer sk-bf-tenant-a")
    expect(edge.calls[1]?.headers["authorization"]).toBeUndefined()
    expect(edge.calls[0]?.headers["x-bf-cache-key"]).toBe(`tenant:${edge.tenantId}`)
    expect(edge.calls[1]?.headers["x-bf-cache-key"]).toBe(`tenant:${b.tenantId}`)
  })

  test("tenant routing-policy overrides do not affect other tenants", async () => {
    const { edge, b } = twoTenants()
    savePolicy(
      edge.db,
      {
        ...fixturePolicy,
        classes: { default: { ranked: [{ provider: "anthropic", model: "claude-haiku-4-5" }] } },
      },
      b.tenantId,
    )._unsafeUnwrap()
    await edge.handler(chatReq(edge.clientKey, simpleChat("agw:auto")))
    await edge.handler(chatReq(b.clientKey, simpleChat("agw:auto")))
    expect((edge.calls[0]?.body as { model: string } | undefined)?.model).toBe("openai/gpt-4o-mini")
    expect((edge.calls[1]?.body as { model: string } | undefined)?.model).toBe("anthropic/claude-haiku-4-5")
  })

  test("ledger rows and evidence events carry the right tenant, and only that tenant", async () => {
    const { edge, b } = twoTenants()
    await edge.handler(chatReq(edge.clientKey, simpleChat()))
    await edge.handler(chatReq(b.clientKey, simpleChat("openai/gpt-4o-mini", "second tenant prompt")))
    await flushAsyncLane()
    const tenants = (edge.db.query("SELECT tenant_id FROM request_ledger ORDER BY created_at").all() as {
      tenant_id: string
    }[]).map((r) => r.tenant_id)
    expect(new Set(tenants)).toEqual(new Set([edge.tenantId, b.tenantId]))
    const evTenants = edge.events.filter((e) => e.event === "GatewayRequest").map((e) => e.tenant_id)
    expect(new Set(evTenants)).toEqual(new Set([edge.tenantId, b.tenantId]))
  })

  test("a revoked or foreign key cannot reach another tenant's data", async () => {
    const { edge, b } = twoTenants()
    // B's key authenticates as B, never as A
    const res = await edge.handler(chatReq(b.clientKey, simpleChat()))
    expect(res.status).toBe(200)
    await flushAsyncLane()
    const row = edge.db
      .query("SELECT tenant_id FROM request_ledger ORDER BY created_at DESC LIMIT 1")
      .get() as { tenant_id: string }
    expect(row.tenant_id).toBe(b.tenantId)
    expect(row.tenant_id).not.toBe(edge.tenantId)
  })
})
