import { describe, expect, test } from "bun:test"

import { checkBudgets, ensureTenantBudget, recordSpend } from "../src/cost/budgets"
import { costUsd } from "../src/cost/pricing"
import { openDb } from "../src/kernel/db"
import { loadPolicy, savePolicy } from "../src/routing/policy"
import { resolveRoute } from "../src/routing/select"
import { buildPolicyFromAplExport } from "../src/routing/sync"
import { fixturePolicy } from "./helpers"

import exportFixture from "../fixtures/apl-eval-export.example.json"

describe("cost/budgets — the circuit breaker", () => {
  test("missing tenant budget denies (fail-closed)", () => {
    const db = openDb(":memory:")
    const res = checkBudgets(db, "t1", null, 5)
    expect(res.isErr()).toBe(true)
    expect(res._unsafeUnwrapErr().code).toBe("budget_missing")
  })

  test("a runaway session trips the run breaker", () => {
    const db = openDb(":memory:")
    ensureTenantBudget(db, "t1", { limitUsd: 1000 })
    // first sight provisions the run budget at the $2 default
    expect(checkBudgets(db, "t1", "run-1", 2).isOk()).toBe(true)
    // runaway loop: spend past the ceiling
    recordSpend(db, "t1", "run-1", 100_000, 2.5)
    const res = checkBudgets(db, "t1", "run-1", 2)
    expect(res.isErr()).toBe(true)
    expect(res._unsafeUnwrapErr()).toEqual({ scope: "run", code: "budget_exceeded" })
    // the tenant scope is untouched
    expect(checkBudgets(db, "t1", null, 2).isOk()).toBe(true)
  })

  test("tenant ceiling trips and lazily resets after the window", () => {
    const db = openDb(":memory:")
    const now = Date.now()
    ensureTenantBudget(db, "t1", { limitUsd: 1, windowMs: 1000 })
    recordSpend(db, "t1", null, 10, 1.2)
    expect(checkBudgets(db, "t1", null, 5, now).isErr()).toBe(true)
    // window rolls over → counters reset, requests flow again
    expect(checkBudgets(db, "t1", null, 5, now + 2000).isOk()).toBe(true)
  })

  test("token ceilings work independently of USD", () => {
    const db = openDb(":memory:")
    ensureTenantBudget(db, "t1", { limitTokens: 100 })
    recordSpend(db, "t1", null, 150, 0)
    expect(checkBudgets(db, "t1", null, 5).isErr()).toBe(true)
  })
})

describe("cost/pricing", () => {
  test("computes route cost from the table", () => {
    const { usd, known } = costUsd("openai/gpt-4o-mini", 1_000_000, 1_000_000)
    expect(known).toBe(true)
    expect(usd).toBeCloseTo(0.75)
  })

  test("unknown models fall back to a conservative overestimate", () => {
    const { usd, known } = costUsd("acme/mystery-model", 1_000_000, 0)
    expect(known).toBe(false)
    expect(usd).toBeGreaterThanOrEqual(10)
  })
})

describe("routing — policy, selection, APL sync", () => {
  test("policy persists and loads (tenant override wins over '*')", () => {
    const db = openDb(":memory:")
    savePolicy(db, fixturePolicy)._unsafeUnwrap()
    const tenantPolicy = {
      ...fixturePolicy,
      classes: { default: { ranked: [{ provider: "anthropic", model: "claude-haiku-4-5" }] } },
    }
    savePolicy(db, tenantPolicy, "tenant-a")._unsafeUnwrap()
    expect(loadPolicy(db, "tenant-a")._unsafeUnwrap()?.classes["default"]?.ranked[0]?.provider).toBe("anthropic")
    expect(loadPolicy(db, "tenant-b")._unsafeUnwrap()?.classes["default"]?.ranked[0]?.provider).toBe("openai")
  })

  test("agw:<class> resolves to the top-ranked route with the rest as fallbacks", () => {
    const decision = resolveRoute(fixturePolicy, "agw:reasoning")._unsafeUnwrap()
    expect(decision.model).toBe("anthropic/claude-sonnet-4-5")
    expect(decision.fallbacks).toEqual(["openai/gpt-4.1"])
    expect(decision.highRisk).toBe(true)
  })

  test("agw:auto uses the default class; explicit models pass through", () => {
    expect(resolveRoute(fixturePolicy, "agw:auto")._unsafeUnwrap().model).toBe("openai/gpt-4o-mini")
    const passthrough = resolveRoute(fixturePolicy, "openai/gpt-4.1")._unsafeUnwrap()
    expect(passthrough.model).toBe("openai/gpt-4.1")
    expect(passthrough.fallbacks).toEqual([])
  })

  test("unknown class and missing policy fail closed", () => {
    expect(resolveRoute(fixturePolicy, "agw:nope").isErr()).toBe(true)
    expect(resolveRoute(null, "agw:auto").isErr()).toBe(true)
  })

  test("builds a policy from an APL eval export, ranked by measured pass rate", () => {
    const policy = buildPolicyFromAplExport(exportFixture)._unsafeUnwrap()
    expect(policy.source.kind).toBe("apl-eval")
    expect(policy.source.evalRunId).toBe("3f6de2a1-6c1e-4b0a-9d2f-example-run")
    expect(policy.defaultClass).toBe("default")
    expect(policy.classes["reasoning"]?.ranked[0]?.model).toBe("claude-sonnet-4-5")
    expect(policy.classes["reasoning"]?.highRisk).toBe(true)
  })

  test("changing the source eval-run changes the routing (the P3 gate)", () => {
    const flipped = {
      ...exportFixture,
      evalRunId: "another-run",
      entries: exportFixture.entries.map((e) =>
        e.taskClass === "reasoning"
          ? { ...e, passRate: e.model === "gpt-4.1" ? 0.99 : 0.9 }
          : e,
      ),
    }
    const p1 = buildPolicyFromAplExport(exportFixture)._unsafeUnwrap()
    const p2 = buildPolicyFromAplExport(flipped)._unsafeUnwrap()
    expect(p1.classes["reasoning"]?.ranked[0]?.model).toBe("claude-sonnet-4-5")
    expect(p2.classes["reasoning"]?.ranked[0]?.model).toBe("gpt-4.1")
    expect(p2.source.evalRunId).toBe("another-run")
  })

  test("an export with only empty suites is refused (empty = fail, never green)", () => {
    const empty = {
      evalRunId: "r",
      entries: [{ taskClass: "default", provider: "openai", model: "m", passRate: 1, total: 0 }],
    }
    expect(buildPolicyFromAplExport(empty).isErr()).toBe(true)
  })
})
