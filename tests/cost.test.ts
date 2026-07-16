/**
 * Cache-adjusted cost + cost-per-verified (dev-env dogfooding export). Under provider
 * prompt caching a cache-read is billed ≈−90%, so a flat total-token cost overstates spend;
 * the ledger must record the honest, cache-adjusted number, and cost-per-verified joins it
 * against judge_verdict on the same row.
 */

import { describe, expect, test } from "bun:test"

import {
  costPerVerifiedOutcome,
  recordLedger,
  setJudgeVerdict,
  type LedgerEntry,
} from "../src/cost/ledger"
import {
  cacheAdjustedCostUsd,
  cacheSavingsRatio,
  DEFAULT_PRICES,
  nominalCostUsd,
} from "../src/cost/pricing"

const P = DEFAULT_PRICES
const SONNET = "anthropic/claude-sonnet-4-5" // in 3, out 15 per MTok

describe("cache-adjusted cost", () => {
  test("cache-read is priced at a deep discount, cache-write at a premium", () => {
    expect(
      cacheAdjustedCostUsd(SONNET, { freshInput: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 }, P).usd,
    ).toBeCloseTo(3, 6)
    expect(
      cacheAdjustedCostUsd(SONNET, { freshInput: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 0 }, P).usd,
    ).toBeCloseTo(0.3, 6) // 10% of $3
    expect(
      cacheAdjustedCostUsd(SONNET, { freshInput: 0, cacheWrite: 1_000_000, cacheRead: 0, output: 0 }, P).usd,
    ).toBeCloseTo(3 * 1.25, 6)
  })

  test("raw cost overstates badly when cache-read dominates; savings ratio quantifies it", () => {
    const split = { freshInput: 35_000, cacheWrite: 500_000, cacheRead: 10_000_000, output: 100_000 }
    expect(nominalCostUsd(SONNET, split, P)).toBeGreaterThan(cacheAdjustedCostUsd(SONNET, split, P).usd * 4)
    expect(cacheSavingsRatio(SONNET, split, P)).toBeGreaterThan(0.7)
  })

  test("no cache tokens → identical to a flat input+output cost (backward compatible)", () => {
    const split = { freshInput: 1000, cacheWrite: 0, cacheRead: 0, output: 500 }
    expect(cacheAdjustedCostUsd("openai/gpt-4o", split, P).usd).toBeCloseTo((1000 * 2.5 + 500 * 10) / 1e6, 9)
  })
})

const entry = (id: string, cost: number): LedgerEntry => ({
  id,
  tenantId: "acme",
  keyId: "k1",
  runId: null,
  taskClass: null,
  model: "m",
  route: SONNET,
  inputHash: "h",
  outcome: "ok",
  guardTags: [],
  protectedPathFlag: false,
  cacheHit: false,
  inputTokens: 100,
  outputTokens: 50,
  costUsd: cost,
  latencyMs: 10,
})

describe("costPerVerifiedOutcome", () => {
  test("cache-adjusted spend per verify-passing outcome, joined on the same ledger row", async () => {
    const { openDb } = await import("../src/kernel/db")
    const db = openDb(":memory:")
    recordLedger(db, entry("a", 0.1))
    setJudgeVerdict(db, "a", "pass")
    recordLedger(db, entry("b", 0.1))
    setJudgeVerdict(db, "b", "pass")
    recordLedger(db, entry("c", 0.1))
    setJudgeVerdict(db, "c", "fail")
    const r = costPerVerifiedOutcome(db, { tenantId: "acme" })
    expect(r.verifiedOutcomes).toBe(2)
    expect(r.totalCostUsd).toBeCloseTo(0.3, 6) // a failed verify still cost money
    expect(r.costPerVerifiedUsd).toBeCloseTo(0.15, 6) // 0.30 total / 2 verified
  })

  test("null when nothing verified (no divide-by-zero)", async () => {
    const { openDb } = await import("../src/kernel/db")
    const db = openDb(":memory:")
    recordLedger(db, entry("x", 0.2)) // no verdict sampled
    expect(costPerVerifiedOutcome(db).costPerVerifiedUsd).toBeNull()
  })
})
