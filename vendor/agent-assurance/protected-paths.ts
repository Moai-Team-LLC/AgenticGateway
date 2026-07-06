/**
 * VENDORED — do not edit. Re-sync with `bun run scripts/sync-vendor.ts`.
 *
 * Sources: AgenticAssurance (AAL Core, npm `agent-assurance`)
 *   - `policy-pack/protected-paths.json` (byte-copied alongside this file;
 *     pack commit f6855b925fa74f999ec347c0e17770af8d7b2c1e)
 *   - `src/policy/protected-paths.ts` (loader + matching;
 *     commit 25df5dda6799c399c65be8944e828d9b48d353fa)
 * License: MIT (Moai Team LLC)
 * Changes (documented excerpt — NOT a re-implementation):
 *   - pack path resolves next to this file (the original resolves
 *     `../../policy-pack` inside its own repo).
 *   - `GUARANTEES_BY_MODE` and `blocksConfigChange` omitted (Claude Code
 *     permission-mode specifics; the gateway gates model *output*, not a
 *     local Claude Code session).
 *   - `globToRegExp` and both matchers are verbatim — the exact single-pass
 *     alternation the reference hook uses (drift between consumers is the
 *     failure mode AAL's own tests guard against; keep it byte-identical).
 *
 * Why vendored: high-impact tool/output policy must reuse AAL's
 * protected-path model, never a parallel one (CLAUDE.md, ADR-0002).
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { z } from "zod"

const protectedPathsSchema = z.object({
  globs: z.array(z.string()).min(1),
  shellMarkers: z.array(z.string()).min(1),
})

export type ProtectedPaths = z.infer<typeof protectedPathsSchema>

const packRoot = dirname(fileURLToPath(import.meta.url))

export const PROTECTED_PATHS: ProtectedPaths = protectedPathsSchema.parse(
  JSON.parse(readFileSync(resolve(packRoot, "protected-paths.json"), "utf8")),
)

const globToRegExp = (glob: string): RegExp => {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // Single alternation pass (longest token first) so `*` inside a `**` expansion is never
    // re-processed — no control-char sentinels needed (keeps oxlint's no-control-regex happy).
    .replace(/\*\*\/|\*\*|\*/g, (m) => (m === "**/" ? "(?:.*/)?" : m === "**" ? ".*" : "[^/]*"))
  return new RegExp(`^${source}$`)
}

const globRegExps = PROTECTED_PATHS.globs.map(globToRegExp)

/** True when a file path a Write/Edit tool targets is a protected control path. */
export const matchesProtectedPath = (filePath: string): boolean =>
  globRegExps.some((re) => re.test(filePath))

/** True when a shell command string reaches into a protected control path. */
export const shellTouchesProtectedPath = (command: string): boolean =>
  PROTECTED_PATHS.shellMarkers.some((marker) => command.includes(marker))
