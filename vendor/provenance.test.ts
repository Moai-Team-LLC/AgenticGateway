/**
 * Vendored files are byte-locked: editing one in place (instead of re-syncing
 * from the sibling + updating the lock) fails here and in the no-reimpl gate.
 */

import { describe, expect, test } from "bun:test"

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import lock from "./PROVENANCE.lock.json"

const root = resolve(import.meta.dir, "..")

describe("vendor provenance", () => {
  test("every vendored file matches its locked sha256", () => {
    const entries = Object.entries(lock as Record<string, string>)
    expect(entries.length).toBeGreaterThanOrEqual(5)
    for (const [file, expected] of entries) {
      const actual = createHash("sha256").update(readFileSync(resolve(root, file), "utf8")).digest("hex")
      expect(`${file}:${actual}`).toBe(`${file}:${expected}`)
    }
  })

  test("vendored guard exports the AgenticMind surface", async () => {
    const guard = await import("./agenticmind/guard")
    expect(typeof guard.guardInput).toBe("function")
    expect(typeof guard.detectInjection).toBe("function")
    expect(typeof guard.redactPii).toBe("function")
    expect(typeof guard.detectOutputLeak).toBe("function")
  })

  test("vendored protected-paths pack parses and matches its reference paths", async () => {
    const pp = await import("./agent-assurance/protected-paths")
    expect(pp.PROTECTED_PATHS.globs.length).toBeGreaterThanOrEqual(5)
    expect(pp.matchesProtectedPath("/repo/.claude/settings.json")).toBe(true)
    expect(pp.matchesProtectedPath("/repo/src/index.ts")).toBe(false)
    expect(pp.shellTouchesProtectedPath("cat .claude/settings.json")).toBe(true)
  })
})
