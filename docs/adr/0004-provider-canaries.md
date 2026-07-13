# ADR-0004: Provider canaries — detecting silent model drift

**Status:** accepted · 2026-07-13

## Context

The gateway sources its routing policy from **measured** AgenticPerformance eval
runs (`agw routing sync --from-file`, [`docs/apl-eval-export.md`](../apl-eval-export.md));
every routing decision is traceable to `source.evalRunId`. That guarantee has a
silent failure mode the family's [Agentic Product Standard v3.1](https://github.com/Moai-Team-LLC/agentic-product-standard)
Part V (*Drift monitoring*) names as **provider drift**: a hosted model is
updated by the provider under the same id. The eval run that justified the route
now describes a model that no longer exists — the pass rate, cost, and latency
the routing policy assumes may all have moved, and nothing in the loop notices.
"temperature-0 is not determinism across providers," so exact-match detection is
not enough; comparison needs semantic-similarity tiers.

## Decision

Add a **provider-canary** module that fits the two-plane seam (ADR-0001) with
**zero new infrastructure and zero data-plane latency cost** — canaries run in
the same async lane as the other assurance work, never on the request path.

- **Pinned canary set (control plane).** Per `(provider, model)` a small,
  version-pinned set of prompts with **pinned reference outputs** and the eval
  run they were captured from. Stored next to the routing policy (SQLite), so a
  canary is traceable to the same `evalRunId` that sourced the route.
- **Scheduling (control plane) / execution (data plane).** The Bun edge schedules
  the canary set on a cadence (default **daily**, per-model configurable);
  execution is an ordinary completion **through Bifrost** — the same provider path
  production traffic takes, so the canary sees what the route sees.
- **Two-tier comparison** (cheap → expensive, escalate only on divergence):
  1. **Semantic similarity** vs. the pinned reference (reuse the edge's embedding
     path from the semantic cache) — above threshold, no drift, done.
  2. **Judge-scored divergence** — only when tier 1 flags — a **calibrated,
     decorrelated** judge (Judge Card, AgenticPerformance) rules on whether the
     output *meaningfully* changed, not merely reworded.
- **Alert path → the eval regression gate.** A tier-2-confirmed divergence is a
  **suspected silent model update** and MUST trigger the eval regression gate
  before continued reliance (Standard DoD 23): the routing policy sourced from the
  now-stale `evalRunId` is **quarantined** for that `(provider, model)` — the edge
  fails over to the next model in the virtual-key chain and emits an assurance
  event — until a fresh AgenticPerformance eval re-sources the route. Because the
  canary also carries reference cost/latency, the same signal catches
  **price/performance shifts** (Layer 9 economics), not just quality.

## Consequences

- **No request-path cost.** Canaries are scheduled async work, like the ledger /
  evidence / judge lanes; the `scripts/bench.ts` P50 gate is unaffected.
- **Coupling stays a documented wire shape.** The canary references the APL
  `evalRunId` and hands drift back to APL's regression gate — the family's
  "optional adapters, never hard dependencies" rule (ADR-0002). The gateway does
  not re-implement evals; it detects the *need* to re-run them.
- **Bounded, ledgered cost.** A pinned set × cadence × N models is a small,
  declared spend; set size and cadence are operator knobs, and the canary spend is
  itself in the cost ledger.
- **Threshold philosophy.** Per the standard, this fixes *that* the similarity
  threshold, cadence, and set size are declared — not their values; they are tuned
  empirically from the first canary runs.

## Acceptance

- [ ] Pinned canary set per `(provider, model)` with reference outputs + source `evalRunId`.
- [ ] Scheduler in the control plane; execution through Bifrost on a configurable cadence.
- [ ] Two-tier comparison (semantic-similarity → decorrelated judge on divergence).
- [ ] Alert path quarantines the stale route and triggers the eval regression gate; drift **and** cost/latency shift both covered.
