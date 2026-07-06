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

/** Extracts guardable text: string contents and text parts, by role. */
const textOfRole = (messages: readonly ChatMessage[], role: string): string => {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role !== role) continue
    if (typeof m.content === "string") {
      parts.push(m.content)
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p === "object" && p !== null && "text" in p && typeof p.text === "string") {
          parts.push(p.text)
        }
      }
    }
  }
  return parts.join("\n")
}

export interface GuardOutcome {
  verdict: GuardVerdict
  /** PII kinds present in user text (evidence tags — never the matches). */
  piiKinds: string[]
}

export const guardRequest = (
  messages: readonly ChatMessage[],
  maxChars: number,
): GuardOutcome => {
  const userText = textOfRole(messages, "user")
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
