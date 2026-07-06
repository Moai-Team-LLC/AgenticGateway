# ADR-0001: Two-plane seam — thin Bun edge over a config-driven Bifrost

**Status:** accepted · 2026-07-06

## Context

The SRS left the integration seam open (§11 Q1–Q3): where do the inline hooks
(guard, budget, cache, route-tag) live — as Bifrost Go plugins (µs, but Go), as
a thin Bun edge in front (TS-only, +1–5 ms), or hybrid? And where does the
cache live?

Facts established against the Bifrost v1.6.x docs before deciding:

- Custom Go plugins are `.so` files whose toolchain, `bifrost/core` version,
  and transitive deps must match the host **exactly**; the official image is
  Alpine/musl; no cross-compilation; and the plugin hook API changed between
  minor versions (v1.3 interface → v1.5 exported functions). That is a brittle
  contract for an OSS repo that pins and bumps images.
- Everything latency-critical we need from the data plane is already a Bifrost
  **built-in**, driven by config: failover (request `fallbacks` + virtual-key
  chains), key load-balancing, retries, streaming, semantic cache
  (`semantic_cache` plugin + vector store), governance (virtual keys with
  budgets/rate limits), OTel.
- The edge's own inline work is deterministic and local: sha256 + one prepared
  SQLite read (auth), regex guard, two prepared reads (budgets), a map lookup
  (routing), an in-memory cache probe.

## Decision

**Hybrid, with zero custom Go.** Bifrost keeps every native concern via
`config.json` (GitOps mode, `config_store.enabled: false`, pinned image
`v1.6.2`). The Bun edge in front does only the cheap deterministic gates and
forwards; all assurance work (ledger, evidence, OTel, anomaly, judge) runs in
an async lane scheduled after the response / stream close.

The cache splits by nature (Q3): **exact** prompt cache in the edge (zero
infra, tenant-scoped keys, < 10 ms hits), **semantic** cache in Bifrost's
plugin (needs a vector store), tenant-scoped by the `x-bf-cache-key:
tenant:<id>` header the edge injects on every forward.

## Consequences

- The latency budget is enforced empirically, not architecturally:
  `scripts/bench.ts` gates CI at < 5 ms P50 added overhead (cache-miss,
  ex-inference), < 10 ms cache hits, < 5 ms streaming TTFB delta. Measured on
  commit: ~0.1 ms added overhead — two orders of magnitude of headroom.
- **Revisit trigger:** if the bench gate ever fails under production-shaped
  load, the escape hatch is moving the guard/budget hooks into a Bifrost Go
  plugin (the original option a) — at the cost of the toolchain coupling above.
- The edge is a single Bun process with in-memory cache and SQLite; horizontal
  scale-out would need a shared cache/store. Out of scope for v0.1 (the data
  plane, which does the heavy lifting, already clusters).
