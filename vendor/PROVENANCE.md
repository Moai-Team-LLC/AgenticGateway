# Vendored sibling contracts — provenance

AgenticGateway composes its siblings; it never re-implements them. Where a sibling
exposes the needed logic only as an in-process library (no HTTP/npm surface yet),
the exact source is **vendored verbatim** here, with a provenance header, and pinned
by sha256 in `PROVENANCE.lock.json`.

Two checks, different strength:

- **The lock is the hard gate.** `provenance.test.ts` and `scripts/sync-vendor.ts
  --check` fail if a vendored file's sha256 no longer matches
  `PROVENANCE.lock.json` — i.e. if a vendored file was edited in place. This needs
  no sibling checkout, so it protects a fresh contributor clone and CI.
- **Sibling drift is advisory.** When a sibling repo is checked out next to this
  one, `--check` also compares the vendored copy to the sibling source and *warns*
  on a mismatch (prompting a deliberate re-sync). It never fails the gate — a
  sibling may be absent or carry uncommitted local edits. Vendored copies track
  the sibling's **committed** canonical source (the commit pinned in each header),
  not a working-tree experiment.

| Vendored file | Source (repo · path · commit) | Mode |
| --- | --- | --- |
| `agenticmind/guard.ts` | AgenticMind · `packages/shared/src/lib/knowledge/guard.ts` · `c7b37ab` | full copy |
| `apl/judge.ts` | AgenticPerformance · `packages/core/src/judge/runner.ts` + `packages/core/src/ai.ts` (types) · `d88f049` | documented excerpt |
| `apl/sampling.ts` | AgenticPerformance · `packages/core/src/eval/mining.ts` (`hashUnit`) · `d88f049` | documented excerpt |
| `agent-assurance/protected-paths.json` | AgenticAssurance · `policy-pack/protected-paths.json` · `f6855b9` | full copy |
| `agent-assurance/protected-paths.ts` | AgenticAssurance · `src/policy/protected-paths.ts` · `25df5dd` | documented excerpt |

**Rules**

1. Never edit a vendored file. Change the sibling upstream, then re-sync.
2. Re-sync: `bun run scripts/sync-vendor.ts` (full copies are regenerated; excerpts
   are diffed and must be updated by hand against the header's "Changes" note).
3. Every re-sync updates `PROVENANCE.lock.json` and must land as its own
   `chore(vendor): sync <name> from <repo>@<commit>` commit.
4. The roadmap replacement for each excerpt is the sibling's published package
   (`@apl/sdk`, an AgenticMind guard export) — switch and delete the vendor copy
   when those exist.
