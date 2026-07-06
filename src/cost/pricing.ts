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
}

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
  z.object({ inPerMTok: z.number().nonnegative(), outPerMTok: z.number().nonnegative() }),
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
