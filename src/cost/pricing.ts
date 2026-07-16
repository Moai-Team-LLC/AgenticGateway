/**
 * Static price table (USD per 1M tokens) keyed by "provider/model" as routed
 * through Bifrost. Prices drift — update freely (or override with a JSON file
 * via `loadPrices`); unknown models fall back to a deliberately conservative
 * rate so budget ceilings overestimate rather than leak spend (fail-closed).
 */

import { readFileSync } from "node:fs"

import { err, ok, type Result } from "neverthrow"
import { z } from "zod"

export interface Price {
  inPerMTok: number
  outPerMTok: number
  /** Cache-read price per MTok. Defaults to inPerMTok × 0.1 (Anthropic ≈ −90%). */
  cacheReadPerMTok?: number
  /** Cache-write price per MTok. Defaults to inPerMTok × 1.25 (Anthropic ≈ +25%). */
  cacheWritePerMTok?: number
}

/** Token usage split by cache role — fresh (full price) / written / read / output. */
export interface TokenSplit {
  freshInput: number
  cacheWrite: number
  cacheRead: number
  output: number
}

const DEFAULT_CACHE_READ_MULT = 0.1
const DEFAULT_CACHE_WRITE_MULT = 1.25

/** Checked against provider list prices, 2026-07. */
export const DEFAULT_PRICES: Record<string, Price> = {
  "openai/gpt-4o-mini": { inPerMTok: 0.15, outPerMTok: 0.6 },
  "openai/gpt-4o": { inPerMTok: 2.5, outPerMTok: 10 },
  "openai/gpt-4.1": { inPerMTok: 2, outPerMTok: 8 },
  "openai/gpt-4.1-mini": { inPerMTok: 0.4, outPerMTok: 1.6 },
  "openai/gpt-4.1-nano": { inPerMTok: 0.1, outPerMTok: 0.4 },
  "openai/o3": { inPerMTok: 2, outPerMTok: 8 },
  "openai/o4-mini": { inPerMTok: 1.1, outPerMTok: 4.4 },
  "anthropic/claude-opus-4-1": { inPerMTok: 15, outPerMTok: 75 },
  "anthropic/claude-sonnet-4-5": { inPerMTok: 3, outPerMTok: 15 },
  "anthropic/claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5 },
}

/** Conservative fallback: overestimates unknown models so ceilings hold. */
export const UNKNOWN_MODEL_PRICE: Price = { inPerMTok: 15, outPerMTok: 75 }

const priceFileSchema = z.record(
  z.string(),
  z.object({
    inPerMTok: z.number().nonnegative(),
    outPerMTok: z.number().nonnegative(),
    cacheReadPerMTok: z.number().nonnegative().optional(),
    cacheWritePerMTok: z.number().nonnegative().optional(),
  }),
)

export const loadPrices = (path: string): Result<Record<string, Price>, string> => {
  try {
    const parsed = priceFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
    if (!parsed.success) return err(`invalid price file: ${parsed.error.issues[0]?.message ?? "parse error"}`)
    return ok({ ...DEFAULT_PRICES, ...parsed.data })
  } catch (e) {
    return err(`cannot read price file: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export const costUsd = (
  route: string,
  inputTokens: number,
  outputTokens: number,
  prices: Record<string, Price> = DEFAULT_PRICES,
): { usd: number; known: boolean } => {
  const price = prices[route]
  const p = price ?? UNKNOWN_MODEL_PRICE
  return {
    usd: (inputTokens * p.inPerMTok + outputTokens * p.outPerMTok) / 1_000_000,
    known: price !== undefined,
  }
}

/**
 * Cache-adjusted $ cost — weights each token by cache role. Under provider prompt caching a
 * cache-READ is billed at ≈−90%, so a cost on TOTAL input tokens overstates spend ~6× when
 * cache-read dominates (measured on our own dev env: 96.5% cache-read). This is the honest
 * cost the ledger and cost-per-verified must use; the flat `costUsd` above overstates.
 */
export const cacheAdjustedCostUsd = (
  route: string,
  split: TokenSplit,
  prices: Record<string, Price> = DEFAULT_PRICES,
): { usd: number; known: boolean } => {
  const price = prices[route]
  const p = price ?? UNKNOWN_MODEL_PRICE
  const crRate = p.cacheReadPerMTok ?? p.inPerMTok * DEFAULT_CACHE_READ_MULT
  const cwRate = p.cacheWritePerMTok ?? p.inPerMTok * DEFAULT_CACHE_WRITE_MULT
  const usd =
    (split.freshInput * p.inPerMTok +
      split.cacheWrite * cwRate +
      split.cacheRead * crRate +
      split.output * p.outPerMTok) /
    1_000_000
  return { usd, known: price !== undefined }
}

/** The cache-BLIND cost (every input-side token at full input rate) — the overstatement
 * `cacheAdjustedCostUsd` corrects; kept so `cacheSavingsRatio` can quantify the gap. */
export const nominalCostUsd = (
  route: string,
  split: TokenSplit,
  prices: Record<string, Price> = DEFAULT_PRICES,
): number => {
  const p = prices[route] ?? UNKNOWN_MODEL_PRICE
  return (
    ((split.freshInput + split.cacheWrite + split.cacheRead) * p.inPerMTok +
      split.output * p.outPerMTok) /
    1_000_000
  )
}

/** Fraction (0..1) that cache adjustment cuts the naive cost — a FinOps signal (a low, or
 * falling, ratio on a long agent = a churning prefix invalidating cache). 0 for an empty call. */
export const cacheSavingsRatio = (
  route: string,
  split: TokenSplit,
  prices: Record<string, Price> = DEFAULT_PRICES,
): number => {
  const nominal = nominalCostUsd(route, split, prices)
  if (nominal === 0) return 0
  return Math.max(0, 1 - cacheAdjustedCostUsd(route, split, prices).usd / nominal)
}
