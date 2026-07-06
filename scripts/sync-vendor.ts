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
  /** Path under a sibling checkout; null for excerpt files (manual sync). */
  source: string | null
  /** For full copies: vendored body below the provenance header must equal the source. */
  mode: "full" | "excerpt"
}

const ENTRIES: VendorEntry[] = [
  {
    vendor: "vendor/agenticmind/guard.ts",
    source: "agenticmind-org/packages/shared/src/lib/knowledge/guard.ts",
    mode: "full",
  },
  {
    vendor: "vendor/agent-assurance/protected-paths.json",
    source: "agent-assurance/policy-pack/protected-paths.json",
    mode: "full",
  },
  { vendor: "vendor/apl/judge.ts", source: "apl/packages/core/src/judge/runner.ts", mode: "excerpt" },
  { vendor: "vendor/apl/sampling.ts", source: "apl/packages/core/src/eval/mining.ts", mode: "excerpt" },
  {
    vendor: "vendor/agent-assurance/protected-paths.ts",
    source: "agent-assurance/src/policy/protected-paths.ts",
    mode: "excerpt",
  },
]

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

/** Body below the provenance header: everything after the first comment-block close (TS files). */
export const vendoredBody = (vendorPath: string, content: string): string => {
  if (vendorPath.endsWith(".json")) return content
  const idx = content.indexOf("*/\n")
  return idx === -1 ? content : content.slice(idx + "*/\n".length)
}

const checkOnly = process.argv.includes("--check")
let drift = false
const lock: Record<string, string> = {}

for (const entry of ENTRIES) {
  const vendorAbs = resolve(repoRoot, entry.vendor)
  const vendorContent = readFileSync(vendorAbs, "utf8")
  const sourceAbs = entry.source === null ? null : resolve(siblingsRoot, entry.source)

  if (sourceAbs !== null && existsSync(sourceAbs)) {
    const sourceContent = readFileSync(sourceAbs, "utf8")
    if (entry.mode === "full") {
      const body = vendoredBody(entry.vendor, vendorContent)
      if (body !== sourceContent) {
        drift = true
        if (checkOnly) {
          console.error(`DRIFT (full copy): ${entry.vendor} != ${entry.source}`)
        } else {
          const header = vendorContent.slice(0, vendorContent.length - body.length)
          writeFileSync(vendorAbs, header + sourceContent)
          console.log(`synced: ${entry.vendor} from ${entry.source}`)
        }
      }
    } else {
      // Excerpts are hand-synced; surface upstream changes for review.
      console.log(
        `excerpt ${entry.vendor}: upstream ${entry.source} sha256=${sha256(sourceContent).slice(0, 16)} — review by hand if changed`,
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
    drift = true
    console.error("DRIFT: vendor/PROVENANCE.lock.json does not match vendored files")
  }
  if (drift) process.exit(1)
  console.log("vendor: clean")
} else {
  writeFileSync(lockPath, lockJson)
  console.log("wrote vendor/PROVENANCE.lock.json")
}
