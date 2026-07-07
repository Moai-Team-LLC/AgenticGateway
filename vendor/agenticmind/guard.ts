/**
 * VENDORED — do not edit. Re-sync with `bun run scripts/sync-vendor.ts`.
 *
 * Source:  AgenticMind `packages/shared/src/lib/knowledge/guard.ts`
 * Commit:  c7b37ab63768a3aa53c85696cb9b0c37136e5981
 * License: Apache-2.0 (Moai Team LLC)
 * Changes: none — byte-identical below this header (drift-checked by
 *          vendor/provenance.test.ts against vendor/PROVENANCE.lock.json).
 *
 * Why vendored: the AgenticGateway contract forbids a second guard
 * implementation; AgenticMind's guard is a pure TS library with no HTTP
 * surface, so verbatim vendoring IS the reuse (CLAUDE.md, ADR-0002).
 */
/**
 * Input guardrails — fail-closed, regex-first (cheap, no LLM). Two checks:
 *   - prompt-injection / jailbreak detection (EN + RU patterns)
 *   - PII detection + redaction (email, phone, card, SSN, IPv4)
 *
 * `guardInput` gates the agent-facing surface: kl_ask_global blocks injected
 * questions; mem_write redacts PII out of stored beliefs. Pure + linear-time
 * (no nested quantifiers -> no ReDoS), so it's unit-tested and trivially fast.
 */

/** Prompt-injection / jailbreak markers. Linear patterns only (bounded
 * quantifiers, no nesting -> no ReDoS). EN + RU, since the corpus and agents are
 * multilingual; the RU patterns avoid `\b` (which keys off ASCII word chars and
 * does not fire around Cyrillic). */
const INJECTION_PATTERNS: readonly RegExp[] = [
  // English
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
  /disregard\s+(?:the\s+)?(?:above|previous|prior|system|earlier)/i,
  /forget\s+(?:everything|all|your|the)\b/i,
  /you\s+are\s+now\s+(?:a|an|the)?\b/i,
  /(?:reveal|show|print|repeat|leak)\s+(?:me\s+)?(?:your\s+)?(?:the\s+)?(?:system\s+)?(?:prompt|instructions?)/i,
  /(?:act|behave|pretend|roleplay)\s+as\s+(?:if\s+)?/i,
  /\b(?:jailbreak|DAN\s+mode|developer\s+mode)\b/i,
  /override\s+(?:the\s+)?(?:rules?|instructions?|system)/i,
  /\bnew\s+instructions?\s*:/i,
  // "system prompt" only when paired with an exfiltration verb (so benign
  // questions that merely mention the system prompt are not over-blocked).
  /(?:reveal|show|print|repeat|leak|dump|expose|share|output)\b[\s\S]{0,40}?system\s+prompt/i,
  // Russian
  /игнорир[а-яё]*\s+[а-яё\s]{0,30}?(?:инструкц|указани|правил|промпт)/iu,
  /забуд[а-яё]*\s+[а-яё\s]{0,20}?(?:инструкц|правил|указани|промпт|контекст|вс[её])/iu,
  /ты\s+(?:теперь|больше\s+не|отныне)/iu,
  /(?:покаж|раскро|выв[еэ]д|повтори|сообщи|напечат)[а-яё]*\s+[а-яё\s]{0,20}?(?:систем[а-яё]*\s*)?промпт/iu,
  /(?:притвор[а-яё]*|прикинься|веди\s+себя\s+как\s+будто|сыгра[а-яё]+\s+роль)/iu,
  /(?:обойд|обход|отключ|сними|сброс)[а-яё]*\s+[а-яё\s]{0,20}?(?:правил|ограничени|инструкц|фильтр|цензур|защит)/iu,
  /нов[а-яё]+\s+(?:инструкц|указани|правил)[а-яё]*\s*:/iu,
  /у\s+теб[яе]\s+нет\s+[а-яё\s]{0,20}?(?:правил|ограничени|инструкц|фильтр)/iu,
  /(?:джейлбрейк|режим\s+разработчика)/iu,
]

export const detectInjection = (text: string): { injection: boolean; pattern?: string } => {
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) {
      return { injection: true, pattern: re.source }
    }
  }
  return { injection: false }
}

/** PII detectors. Order matters (card before phone -- both are digit runs). */
export const PII_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "email", re: /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/giu },
  { kind: "credit_card", re: /\b(?:\d[ -]?){13,16}\b/g },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "ipv4", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { kind: "phone", re: /\+?\d[\d().\s-]{8,}\d/g },
]

export const findPii = (text: string): { kind: string; match: string }[] => {
  const out: { kind: string; match: string }[] = []
  for (const { kind, re } of PII_PATTERNS) {
    for (const m of text.matchAll(re)) {
      out.push({ kind, match: m[0] })
    }
  }
  return out
}

/** Replaces detected PII with [redacted:<kind>]. Returns the redacted text + kinds found. */
export const redactPii = (text: string): { redacted: string; found: string[] } => {
  let redacted = text
  const found = new Set<string>()
  for (const { kind, re } of PII_PATTERNS) {
    if (re.test(redacted)) {
      found.add(kind)
      redacted = redacted.replace(re, `[redacted:${kind}]`)
    }
  }
  return { redacted, found: [...found] }
}

export type GuardVerdict = {
  ok: boolean
  /** Why it was blocked (only when ok=false). */
  reason?: string
  /** Diagnostic tags (e.g. "injection", "too_long"). Never the offending text. */
  tags: string[]
}

const MAX_INPUT_CHARS = 8000

/**
 * Fail-closed input gate for agent-facing text. Blocks prompt-injection and
 * over-length input. PII is NOT blocked here (callers redact instead).
 */
export const guardInput = (text: string, opts?: { maxChars?: number }): GuardVerdict => {
  const maxChars = opts?.maxChars ?? MAX_INPUT_CHARS
  if (text.length > maxChars) {
    return { ok: false, reason: `input exceeds ${maxChars} chars`, tags: ["too_long"] }
  }
  const inj = detectInjection(text)
  if (inj.injection) {
    return { ok: false, reason: "possible prompt injection", tags: ["injection"] }
  }
  return { ok: true, tags: [] }
}

/** Markers that should never appear in a grounded answer (system-prompt leak). */
const LEAK_MARKERS: readonly RegExp[] = [
  /you\s+are\s+a\s+knowledge-base\s+assistant/i,
  /the\s+numbered\s+sources/i,
  /\[system\]/i,
  /system\s+prompt\s*:/i,
  /cite\s+the\s+sources\s+you\s+used/i,
]

const normWs = (s: string): string => s.toLowerCase().replaceAll(/\s+/gu, " ").trim()

/**
 * Output-side guard: detects whether the synthesised answer leaked the system
 * prompt — either a long verbatim span of it, or a known leak marker. Used by
 * `ask` to replace a leaked answer with a safe fallback.
 */
export const detectOutputLeak = (
  answer: string,
  systemPrompt: string,
): { leaked: boolean; reason?: string } => {
  const a = normWs(answer)
  const sp = normWs(systemPrompt)
  // A real system-prompt leak regurgitates a long verbatim stretch of the
  // instruction scaffold. Coincidental overlaps — a common guideline phrase, a
  // restated caller-context fact, or prose resembling the prompt's example
  // answers — are short. A 60-char window flagged those legitimate answers
  // (non-deterministic false refusals); 120 chars keeps real-leak detection
  // (any regurgitated instruction sentence is longer) while dropping the noise.
  const WINDOW = 120
  for (let i = 0; i + WINDOW <= sp.length; i += 20) {
    if (a.includes(sp.slice(i, i + WINDOW))) {
      return { leaked: true, reason: "verbatim system-prompt span" }
    }
  }
  for (const re of LEAK_MARKERS) {
    if (re.test(answer)) {
      return { leaked: true, reason: "system-prompt leak marker" }
    }
  }
  return { leaked: false }
}
