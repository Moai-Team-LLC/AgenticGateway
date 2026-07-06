# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-06

### Added

- **One-key edge (Layer 1):** OpenAI-compatible `POST /v1/chat/completions`;
  tenant + identity derived from the `sk-agw-*` key (sha256-stored); fail-closed
  auth; streaming passthrough with an async tap.
- **Key vault:** per-tenant upstream credentials (Bifrost virtual keys)
  AES-256-GCM-encrypted at rest, rotation without client change; upstream keys
  never reach clients, logs, or evidence.
- **Bifrost data plane:** pinned `maximhq/bifrost:v1.6.2` compose + GitOps
  `config.json` (env-ref provider keys, `config_store` disabled); optional
  Redis profile for the semantic-cache plugin.
- **Budgets (Layer 9):** tenant-window and per-run cost/token ceilings enforced
  in code with a fail-closed circuit breaker; missing budget = deny.
- **Routing policy:** per task-class rankings built from an AgenticPerformance
  eval export (`eval_run_id` + `synced_at` recorded); `agw:<class>` /
  `agw:auto` selection as a map lookup; ranking → Bifrost `fallbacks`;
  per-tenant overrides.
- **Exact prompt cache** (tenant-scoped LRU+TTL) short-circuiting before any
  provider call; tenant-scoped `x-bf-cache-key` for Bifrost's semantic cache.
- **Cost-per-outcome traces:** OTLP/JSON spans in AgenticPerformance's
  conventions (OTel GenAI semconv + `apl.cost_usd` etc.), joining the caller's
  `traceparent`.
- **Spend anomaly detection** per key with optional automatic throttling.
- **Delegated assurance:** AgenticMind guard inline (vendored verbatim,
  provenance-locked) + output-leak gate; AgenticAssurance protected-path scan
  over tool calls (report/block); sampled AgenticPerformance judge on
  high-risk routes (async); hash-not-text evidence events (file JSONL or the
  AgenticMind `/hooks/audit` wire).
- **CLI (`agw`):** serve, tenant/key/vault lifecycle, routing sync/show,
  Bifrost config regeneration, read-only inspection; mutations audited as
  evidence events.
- **Gates in CI:** full check (oxlint, strict tsc, 76 tests), no-reimplementation
  grep, vendor provenance lock, cross-tenant isolation suite, and a latency
  bench (P50 added overhead < 5 ms ex-inference; cache hit < 10 ms; streaming
  TTFB delta < 5 ms).

[0.1.0]: https://github.com/Moai-Team-LLC/AgenticGateway/releases/tag/v0.1.0
