/**
 * Protected-path scan (FR-D.3 / Cycle of Trust) — applies AgenticAssurance's
 * vendored pack to model OUTPUT: tool calls in a completion that reach for an
 * agent's own control surfaces (settings, hooks, agent/MCP definitions) are
 * flagged (report mode) or denied (block mode). The gateway never rewrites a
 * tool call and never auto-approves — it reports and gates only. Hits carry
 * tool names and marker kinds, never argument content.
 */

import {
  matchesProtectedPath,
  shellTouchesProtectedPath,
} from "../../vendor/agent-assurance/protected-paths"

const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const

export interface ProtectedScan {
  flagged: boolean
  /** e.g. ["Write:path", "Bash:shell"] — names + marker kinds only. */
  hits: string[]
}

interface ToolCallish {
  function?: { name?: unknown; arguments?: unknown }
}

export const scanCompletionForProtectedPaths = (completion: unknown): ProtectedScan => {
  const hits: string[] = []
  if (typeof completion !== "object" || completion === null) return { flagged: false, hits }
  const choices = (completion as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return { flagged: false, hits }
  for (const choice of choices) {
    const toolCalls = (choice as { message?: { tool_calls?: unknown } }).message?.tool_calls
    if (!Array.isArray(toolCalls)) continue
    for (const call of toolCalls as ToolCallish[]) {
      const name = typeof call.function?.name === "string" ? call.function.name : "unknown_tool"
      const rawArgs = typeof call.function?.arguments === "string" ? call.function.arguments : ""
      let parsed: unknown = null
      try {
        parsed = JSON.parse(rawArgs)
      } catch {
        // unparseable arguments still get the substring shell check below
      }
      if (typeof parsed === "object" && parsed !== null) {
        for (const field of PATH_FIELDS) {
          const value = (parsed as Record<string, unknown>)[field]
          if (typeof value === "string" && matchesProtectedPath(value)) {
            hits.push(`${name}:path`)
          }
        }
      }
      if (shellTouchesProtectedPath(rawArgs)) {
        hits.push(`${name}:shell`)
      }
    }
  }
  return { flagged: hits.length > 0, hits: [...new Set(hits)] }
}
