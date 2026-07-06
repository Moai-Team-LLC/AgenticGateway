# AgenticGateway — contract for Claude Code

Guidance for AI coding agents working in this repository. Read this fully before editing.

## What this is
The reference implementation of the Agentic Product Standard's **Layer 1 (Model & provider)**
and **Layer 9 (Cost & FinOps)** — the two harness surfaces with no substrate yet. It gives the
family **one OpenAI-compatible key** and, behind it, does provider access, cost/FinOps, routing,
and caching — while **delegating** guardrails, judging, red-team, and identity to the sibling
substrates. It is **not** a generic gateway and **not** an agent runtime.

**Two planes — keep them separate:**
- **Data plane = Bifrost (Go).** Owns provider abstraction, failover, load-balancing, retries,
  streaming, at ~µs overhead. We run and configure it; we do **not** reinvent it.
- **Control plane = this repo (Bun/TS).** Owns the one-key edge, key vault, budgets, routing
  policy, and the async assurance lane. Stays **off the hot path**.

## Part of a suite — read the canon and compose, don't duplicate
- **agentic-product-standard** — the contract (Layer 1, Layer 9, the Scorecard Cost items).
- **AgenticMind** — guard (injection/PII) + the evidence sink. We **call** its guard; we never
  write a second one.
- **AgenticPerformance** — LLM judges + eval history. Routing policy is **sourced from it**;
  judging is **delegated to it** (async/sampled).
- **AgenticAssurance** — red-team + `policy-pack/protected-paths.json`. High-impact policy reuses
  its protected-path model; we never author a parallel one.

Sibling logic is reused by **verbatim vendoring with provenance** (`vendor/`, see
`vendor/PROVENANCE.md`): the files are byte-copies of the sibling sources, pinned by sha256 in
`vendor/PROVENANCE.lock.json` and drift-checked in tests. Never edit a vendored file — re-sync it
with `scripts/sync-vendor.ts` instead.

## Hard invariants (never violate)
- **No transport rewrite.** All provider I/O goes through Bifrost. The control plane never calls
  a provider directly. Adding a provider is Bifrost config, not code here.
- **No re-implementation of siblings.** No second guard, judge, red-team engine, or provider
  adapters in this repo. A CI grep check enforces this — do not defeat it.
- **Latency is a hard constraint — two lanes.** Hot path only does cheap deterministic work
  (auth O(1), sub-ms guard hook, cache lookup, route-tag). **Never put an LLM judge on the hot
  path** — judging is async/sampled. Added hot-path overhead target < 5 ms P50 (cache-miss,
  excluding inference); a cache hit returns < ~10 ms.
- **Fail-closed.** Missing tenant, blown budget, or an inconclusive guard result denies or
  degrades — never silently passes.
- **Hash-not-text.** Provider keys and raw prompts/payloads never appear in logs, traces, or
  evidence. Reference by sha256 (the `guard_events` contract).
- **Cycle of Trust.** This repo composes AgenticAssurance's protected-path policy. It reports and
  gates; it never auto-approves a side-effecting action.
- **Tenant isolation.** Keys, budgets, cache, routing policy, traces, evidence are tenant-scoped;
  a cross-tenant leakage test runs in CI.

## Commands
```bash
bun run check          # lint + typecheck + tests + no-reimpl grep (the full gate)
bun run dev            # control plane against a local Bifrost
docker compose -f bifrost/docker-compose.yml up -d   # bring up the Bifrost data plane
bun run bench          # hot-path latency bench (fails if P50 overhead > 5 ms ex-inference)
```
Lint (`oxlint`) needs Node ≥ 22.18 (`.nvmrc`); the rest run under Bun.

## Conventions (honor)
- **Conventional Commits** (commitlint + husky `commit-msg` hook + CI). Header ≤ 72 chars.
- Strict TypeScript, functional style, `neverthrow` `Result` types (don't throw for control flow).
- `zod` on every external boundary (client requests, config, routing policy, vault I/O).
- **Every new failure mode becomes a permanent test.** No route/policy without a test.
- No secrets in code/tests/fixtures. `dotenvx` for runtime secrets; provider keys live only in
  the vault (and Bifrost's env refs).

## Where things live
```text
bifrost/            ← Bifrost data-plane compose + config.json (env-ref keys, GitOps mode)
src/kernel/         ← config (zod env), sqlite store, crypto (sha256, AES-GCM), logging
src/edge/           ← one-key OpenAI-compatible entry, auth, tenant derivation, hot path (L1)
src/vault/          ← provider-key vault: client key → per-tenant upstream keys, rotation (L1)
src/routing/        ← routing policy: sync from AgenticPerformance → route selection (L9)
src/cost/           ← budgets, per-run ceilings/circuit-breaker, pricing, anomaly, OTel (L9)
src/cache/          ← exact prompt cache short-circuit (semantic cache = Bifrost plugin) (L9)
src/delegate/       ← thin wrappers over vendored sibling contracts: guard, evidence, judge,
                      protected-paths (compose, never re-implement)
vendor/             ← verbatim sibling sources + PROVENANCE (drift-checked; never edit)
src/cli.ts          ← run/inspect gateway; tenants/keys/vault; regenerate Bifrost config
scripts/            ← no-reimpl-check.sh, bench.ts, sync-vendor.ts
```

## The integration seam (decided for v0.1 — ADR-0001)
Bifrost owns everything latency-critical that it ships natively: provider failover/LB (virtual
keys), retries, streaming, semantic cache (plugin + Redis), OTel. The Bun edge in front adds only
cheap deterministic work (auth, guard, budget, cache lookup, route-tag) and is benched against
the < 5 ms P50 budget. No custom Go plugins in v0.1 (brittle `.so` toolchain coupling — see ADR);
revisit if the bench ever fails.

## How to verify a change works
Run `bun run check` **and** `bun run bench`. A change touching the hot path must not regress the
latency budget. A change that looks like guarding, judging, or red-teaming is almost certainly in
the wrong repo — delegate to the sibling instead.
