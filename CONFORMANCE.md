# Conformance — AgenticGateway vs the Agentic Product Standard

Maps this repo onto the Standard's technology stack (Part II) and SCORECARD,
and reports gaps honestly (an early-member conformance report, per
ECOSYSTEM.md's convention). "Layer" numbers refer to the Standard's
**technology stack** (Layers 1–9), not the 8-layer harness.

## Layer 1 — Model and provider

| Requirement | Implementation | State |
|---|---|---|
| Multi-provider from the start; use an abstraction | Bifrost data plane; two providers ship in `bifrost/data/config.json`; adding one is config (`agw bifrost-config`) | ✅ |
| Tiered routing: small model for routing/classification, flagship for reasoning; per-agent model assignment | `agw:<task-class>` routing policy, per-tenant overrides; selection = map lookup (no LLM on the hot path) | ✅ |
| Prompt caching on stable prefixes | Exact cache at the edge (tenant-scoped); semantic cache via Bifrost's `semantic_cache` plugin, tenant-scoped by the injected `x-bf-cache-key` | ✅ / plugin opt-in |
| Key management: client key never exposes upstream keys | Vault: `sk-agw-*` stored as sha256; upstream Bifrost VK AES-GCM-encrypted at rest; rotation without client change | ✅ tested |

## Layer 9 — Cost & FinOps

| Requirement | Implementation | State |
|---|---|---|
| Per-run token/cost ceiling **enforced in code** (circuit breaker) | `src/cost/budgets.ts`: tenant-window + per-run scopes, fail-closed (missing budget = deny), trips on crossing | ✅ tested |
| Prompt/KV caching | as above | ✅ |
| Model routing / cascades | routing policy sourced from AgenticPerformance eval runs (`eval_run_id` + `synced_at` recorded); ranking → Bifrost `fallbacks` | ✅ tested |
| Cost-per-outcome in the same traces as Layer 6 | OTLP/JSON spans in APL's conventions (GenAI semconv + `apl.cost_usd`, `apl.outcome`; identity on the Resource; joins caller `traceparent`) → APL ingest `/v1/traces` | ✅ tested |
| Spend anomaly | deterministic ledger-based detector (5-min window vs trailing-hour baseline), alert + optional key throttle | ✅ tested |
| Multi-agent 15× economics rule | out of scope for a gateway (a design-review rule, not a runtime control); the ledger provides the per-run numbers to apply it | N/A |

## SCORECARD "Cost" gates (all M2)

- ✅ **Per-run token/cost ceiling in code** — `budgets.ts`, breaker test in `tests/budgets-routing.test.ts`.
- ✅ **Prompt/KV caching + cost-per-task in traces** — `cache/exact.ts`, `cost/otel.ts`.
- N/A **Multi-agent 15× justification** — gateway supplies the measurements; the judgment call lives with the product using it.

## Cross-cutting invariants (the family contract)

- **Fail-closed**: no key → 401; no tenant budget → 429; unknown task class →
  400; vault error → 500-deny; leak in output → 502-deny. All tested.
- **Hash-not-text**: ledger and evidence carry `input_hash` (sha256) only;
  tests assert no prompt/response text or upstream secret in rows, events,
  spans, or error bodies.
- **Cycle of Trust**: protected-path tool calls are flagged (default) or denied
  (`AGW_PROTECTED_PATH_MODE=block`); the gateway never rewrites or
  auto-approves a side effect.
- **Tenant isolation**: keys, budgets, cache, vault, routing, ledger, evidence
  — `tests/isolation.test.ts`, CI-gated.
- **Two-lane latency**: bench gates in CI (`scripts/bench.ts`): added P50
  overhead < 5 ms ex-inference (measured ~0.1 ms), cache hit < 10 ms,
  streaming TTFB delta < 5 ms.

## Honest gaps (v0.1)

1. **Routing sync is file-based.** AgenticPerformance ships no read API yet, so
   `agw routing sync` consumes a JSON eval export (SQL provided in
   [docs/apl-eval-export.md](docs/apl-eval-export.md)); task classes come from
   APL case tags by operator-run SQL, and the provider column is a manual
   mapping from `model_snapshot_id`. When `@apl/sdk` ships, sync moves to it.
2. **The HTTP evidence sink targets a pending upstream endpoint.** AgenticMind's
   `POST /hooks/audit` (tool_audit_events) exists as the WS2 patch, not yet in
   its main. The default sink is therefore a local JSONL file with the same
   hash-not-text shape; flip `AGW_EVIDENCE_SINK=http` once the endpoint lands.
3. **Streaming output gates are flag-only.** Streamed bytes are already with
   the client, so the leak check on the accumulated stream can only record
   evidence, not block. Non-streaming responses are gated fail-closed.
4. **Guard scope.** Injection patterns are AgenticMind's EN+RU regex set —
   deterministic and sub-ms by design, not an ML classifier. PII in requests is
   tagged for evidence, not redacted: a gateway must not alter payloads it
   forwards (AgenticMind redacts at its own memory-write boundary).
5. **Judge verdicts feed the ledger, not yet the policy.** Sampled judge
   results land in `request_ledger.judge_verdict` (and evidence); closing the
   loop into the next routing sync is a roadmap item (T6.3's "over time").
6. **Semantic cache needs infra.** Bifrost's plugin requires a vector store
   (Redis profile in the compose file) and an embedding key; the exact cache
   works with zero infra.
7. **Price table is static.** `src/cost/pricing.ts` is a checked-in table
   (2026-07); unknown models cost-estimate conservatively high so ceilings
   hold. Override via `loadPrices`.
