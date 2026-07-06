/**
 * Vendor sync — regenerates full-copy vendored files from sibling checkouts,
 * reports drift on excerpt files, and rewrites vendor/PROVENANCE.lock.json.
 *
 * Usage: bun run scripts/sync-vendor.ts [--check]
 *   --check  verify only (no writes); exit 1 on drift. Used by provenance tests
 *            when sibling repos are present.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const siblingsRoot = process.env["AGW_SIBLINGS_ROOT"] ?? resolve(repoRoot, "..")

interface VendorEntry {
  vendor: string
  /** Repo dir candidates (public name first, maintainer checkout name second)
   *  + path within it; null source = excerpt file with no full-copy check. */
  repoDirs: string[]
  sourcePath: string | null
  /** For full copies: vendored body below the provenance header must equal the source. */
  mode: "full" | "excerpt"
}

const ENTRIES: VendorEntry[] = [
  {
    vendor: "vendor/agenticmind/guard.ts",
    repoDirs: ["AgenticMind", "agenticmind-org"],
    sourcePath: "packages/shared/src/lib/knowledge/guard.ts",
    mode: "full",
  },
  {
    vendor: "vendor/agent-assurance/protected-paths.json",
    repoDirs: ["AgenticAssurance", "agent-assurance"],
    sourcePath: "policy-pack/protected-paths.json",
    mode: "full",
  },
  {
    vendor: "vendor/apl/judge.ts",
    repoDirs: ["AgenticPerformance", "apl"],
    sourcePath: "packages/core/src/judge/runner.ts",
    mode: "excerpt",
  },
  {
    vendor: "vendor/apl/sampling.ts",
    repoDirs: ["AgenticPerformance", "apl"],
    sourcePath: "packages/core/src/eval/mining.ts",
    mode: "excerpt",
  },
  {
    vendor: "vendor/agent-assurance/protected-paths.ts",
    repoDirs: ["AgenticAssurance", "agent-assurance"],
    sourcePath: "src/policy/protected-paths.ts",
    mode: "excerpt",
  },
]

/** First repoDir that exists under siblingsRoot, else null. */
const resolveSource = (entry: VendorEntry): string | null => {
  if (entry.sourcePath === null) return null
  for (const dir of entry.repoDirs) {
    const candidate = resolve(siblingsRoot, dir, entry.sourcePath)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

/** Body below the provenance header: everything after the first comment-block close (TS files). */
export const vendoredBody = (vendorPath: string, content: string): string => {
  if (vendorPath.endsWith(".json")) return content
  const idx = content.indexOf("*/\n")
  return idx === -1 ? content : content.slice(idx + "*/\n".length)
}

const checkOnly = process.argv.includes("--check")
// The HARD gate is the provenance lock (vendored sha256 == lock) — it catches
// in-place edits with no sibling checkout, so it protects a fresh contributor
// clone and CI. Sibling drift is ADVISORY: a sibling may be absent or have
// uncommitted local edits, so it warns (to prompt a deliberate re-sync) but
// never fails the gate.
let lockMismatch = false
const lock: Record<string, string> = {}

for (const entry of ENTRIES) {
  const vendorAbs = resolve(repoRoot, entry.vendor)
  const vendorContent = readFileSync(vendorAbs, "utf8")
  const sourceAbs = resolveSource(entry)

  if (sourceAbs !== null) {
    const sourceContent = readFileSync(sourceAbs, "utf8")
    if (entry.mode === "full") {
      const body = vendoredBody(entry.vendor, vendorContent)
      if (body !== sourceContent) {
        if (checkOnly) {
          console.warn(`warn: ${entry.vendor} differs from sibling ${sourceAbs} — re-sync if that checkout is canonical`)
        } else {
          const header = vendorContent.slice(0, vendorContent.length - body.length)
          writeFileSync(vendorAbs, header + sourceContent)
          console.log(`synced: ${entry.vendor} from ${sourceAbs}`)
        }
      }
    } else {
      // Excerpts are hand-synced; surface upstream changes for review.
      console.log(
        `excerpt ${entry.vendor}: upstream sha256=${sha256(sourceContent).slice(0, 16)} — review by hand if changed`,
      )
    }
  } else if (checkOnly) {
    console.log(`skip (no sibling checkout): ${entry.vendor}`)
  }

  lock[entry.vendor] = sha256(readFileSync(vendorAbs, "utf8"))
}

const lockPath = resolve(repoRoot, "vendor/PROVENANCE.lock.json")
const lockJson = `${JSON.stringify(lock, null, 2)}\n`
if (checkOnly) {
  const current = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : ""
  if (current !== lockJson) {
    lockMismatch = true
    console.error("FAIL: a vendored file was edited in place (sha256 != vendor/PROVENANCE.lock.json)")
  }
  if (lockMismatch) process.exit(1)
  console.log("vendor: lock clean")
} else {
  writeFileSync(lockPath, lockJson)
  console.log("wrote vendor/PROVENANCE.lock.json")
}
