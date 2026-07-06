/**
 * Inline guard (FR-D.1) — a thin wrapper over AgenticMind's vendored guard.
 * No detection logic lives here: patterns, verdict semantics, and the leak
 * check are the sibling's, byte-for-byte (vendor/agenticmind/guard.ts).
 * Injection / over-length blocks fail closed; PII is tagged for evidence but
 * (unlike AgenticMind's mem_write) NOT rewritten — a gateway must not alter
 * payloads it forwards.
 */

import {
  detectOutputLeak,
  findPii,
  guardInput,
  type GuardVerdict,
} from "../../vendor/agenticmind/guard"

interface ChatMessage {
  role: string
  content: unknown
}

/** Flattens a message's content (string, or text parts of an array) to text. */
const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const p of content) {
    if (typeof p === "object" && p !== null && "text" in p && typeof p.text === "string") parts.push(p.text)
  }
  return parts.join("\n")
}

const textOfRole = (messages: readonly ChatMessage[], role: string): string =>
  messages
    .filter((m) => m.role === role)
    .map((m) => contentText(m.content))
    .join("\n")

/** The most recent user turn — the new, untrusted input this request adds. */
const latestUserText = (messages: readonly ChatMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m !== undefined && m.role === "user") return contentText(m.content)
  }
  return ""
}

export interface GuardOutcome {
  verdict: GuardVerdict
  /** PII kinds present in the new user turn (evidence tags — never the matches). */
  piiKinds: string[]
}

/**
 * Guards the LATEST user turn only — the new input this request contributes.
 * Guarding the whole re-sent history would (a) permanently block a
 * conversation once any single turn tripped a pattern, and (b) re-scan
 * trusted prior turns. The system/assistant/tool messages are the operator's
 * own prompt and prior model output, not the untrusted surface this gate
 * exists for. Fail-closed on the new turn.
 */
export const guardRequest = (messages: readonly ChatMessage[], maxChars: number): GuardOutcome => {
  const userText = latestUserText(messages)
  const verdict = guardInput(userText, { maxChars })
  const piiKinds = [...new Set(findPii(userText).map((p) => p.kind))]
  return { verdict, piiKinds }
}

/** Output-side check (non-streaming): did the completion leak the system prompt? */
export const guardResponseLeak = (
  messages: readonly ChatMessage[],
  responseText: string,
): { leaked: boolean; reason?: string } => {
  const systemText = textOfRole(messages, "system")
  return detectOutputLeak(responseText, systemText)
}
