/**
 * VENDORED — do not edit. Re-sync with `bun run scripts/sync-vendor.ts`.
 *
 * Sources: AgenticPerformance (APL)
 *   - `packages/core/src/judge/runner.ts` (runJudge + verdict parsing)
 *   - `packages/core/src/ai.ts` (the injected AplChat port)
 * Commit:  d88f049b85b00df88f079347d9a64ae62568dea7
 * License: Apache-2.0 (Moai Team LLC)
 * Changes (documented excerpt — NOT a re-implementation):
 *   - `AplChatRequest`/`AplChat` inlined verbatim from ai.ts (the runner
 *     imports them as a type); the default Vercel-AI-SDK adapter is NOT
 *     vendored — AgenticGateway injects its own chat that routes through
 *     Bifrost (the judge itself stays APL's, byte-for-byte).
 *   - `calibrateWithJudge` omitted (pulls the calibration module; gateway
 *     samples single verdicts, it does not calibrate judges).
 *
 * Why vendored: judging is delegated to AgenticPerformance; its judge is a
 * pure function with an injected chat boundary and no network API, so
 * verbatim vendoring IS the delegation until `@apl/sdk` is published
 * (ADR-0002).
 */

// ── from packages/core/src/ai.ts ────────────────────────────────────────────
export interface AplChatRequest {
  prompt: string
  system?: string
  /** OpenAI-compatible model id; operators configure per deployment. */
  model?: string
}

export type AplChat = (request: AplChatRequest) => Promise<string>

// ── from packages/core/src/judge/runner.ts ──────────────────────────────────
export interface JudgeExample {
  id: string
  input: string
  expected: boolean
}

/** Default system framing — a binary, first-line PASS/FAIL judge (never Likert). */
const DEFAULT_SYSTEM =
  "You are a strict binary judge. Answer only PASS if the item is supported, otherwise FAIL. " +
  "Put the single word PASS or FAIL on the first line."

/** Positive verdict vocabulary parsed off the judge's first non-empty line. */
const PASS_PATTERN = /\b(pass|supported|yes|true)\b/i

const firstNonEmptyLine = (text: string): string => {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ""
}

const buildPrompt = (input: string): string =>
  `Item to evaluate:\n${input}\n\nIs it supported? Answer PASS or FAIL on the first line.`

/**
 * Runs the judge over every example. Each verdict is parsed from the first
 * non-empty line; a chat throw yields got=false. Order matches `examples`.
 */
export const runJudge = async (
  examples: readonly JudgeExample[],
  chat: AplChat,
  opts?: { system?: string; model?: string },
): Promise<{ id: string; expected: boolean; got: boolean }[]> => {
  const system = opts?.system ?? DEFAULT_SYSTEM
  const results: { id: string; expected: boolean; got: boolean }[] = []
  for (const example of examples) {
    let got = false
    try {
      const reply = await chat({ system, prompt: buildPrompt(example.input), model: opts?.model })
      got = PASS_PATTERN.test(firstNonEmptyLine(reply))
    } catch {
      got = false
    }
    results.push({ id: example.id, expected: example.expected, got })
  }
  return results
}
