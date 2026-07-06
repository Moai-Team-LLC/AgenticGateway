# ADR-0002: Sibling reuse by verbatim vendoring with a provenance lock

**Status:** accepted · 2026-07-06

## Context

The contract forbids re-implementing sibling surfaces: no second guard
(AgenticMind), judge (AgenticPerformance), or protected-path policy
(AgenticAssurance). But none of the needed logic is consumable as a dependency
today, verified against the live repos:

- AgenticMind's guard (`guardInput`, PII, output-leak) is a pure TS module
  inside a private workspace package, with **no HTTP endpoint** — there is no
  guard sidecar to call.
- AgenticPerformance's judge (`runJudge`) is a pure function with an injected
  `AplChat`; `@apl/core` is `private: true` and `@apl/sdk` is not yet published.
- AgenticAssurance publishes to npm, but its policy module resolves
  `policy-pack/` relative to its own source, and the matcher's glob→regex
  conversion is deliberately duplicated verbatim across its consumers with
  drift tests — the pattern to follow is byte-identical copies, not
  re-expression.

The SRS offered "port the regex to a Go plugin, or call a sidecar" (Q2). ADR-0001
removed the Go plugin path; a sidecar doesn't exist to call.

## Decision

Vendor the exact sibling sources under `vendor/`, byte-for-byte, each with a
provenance header (source repo, path, commit, license, documented omissions).
Enforcement:

- `vendor/PROVENANCE.lock.json` pins the sha256 of every vendored file;
  `vendor/provenance.test.ts` and the CI no-reimpl gate fail on any in-place
  edit.
- `scripts/sync-vendor.ts` re-syncs full copies from sibling checkouts and
  flags excerpt files for hand-review; every re-sync is its own
  `chore(vendor)` commit.
- `scripts/no-reimpl-check.sh` greps `src/` for guard patterns, judge verdict
  logic, protected-path literals, provider SDKs, and provider hosts — sibling
  logic can only exist under `vendor/`.

Excerpts are allowed only where the source file drags APL-internal modules
(calibration, golden-set splitting) and are documented line-by-line in the
header ("Changes:").

## Consequences

- Reuse is real (the guard that runs here IS AgenticMind's, to the byte) while
  the repo stays standalone — an OSS user needs no sibling checked out.
- Upstream changes don't propagate automatically; the sync script + lock make
  drift visible and re-sync cheap. When siblings publish packages
  (`@apl/sdk`, an AgenticMind guard export, `agent-assurance`'s policy module
  with a bundled pack), the roadmap is: depend, delete the vendor copy, keep
  the delegate-layer API stable.
- The `guardInput` max-length default (8000 chars, tuned for AgenticMind's
  ask-surface) is overridden via its own `opts.maxChars` API
  (`AGW_GUARD_MAX_CHARS`, default 512k) — configuration through the vendored
  API, never a fork of it.
