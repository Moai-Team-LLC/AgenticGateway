/**
 * Structured JSON logging. Discipline, not cleverness: callers pass only
 * hashes/ids/counters — never message bodies, never keys (hash-not-text).
 */

type Level = "info" | "warn" | "error"

export const log = (level: Level, event: string, fields: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })
  if (level === "error") console.error(line)
  else console.log(line)
}
