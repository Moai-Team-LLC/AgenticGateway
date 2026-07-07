# AgenticGateway

[![Agentic Product Standard: Model & provider · Cost & FinOps](https://img.shields.io/badge/Agentic_Product_Standard-Model_%26_provider_·_Cost_%26_FinOps-1E607A)](https://github.com/Moai-Team-LLC/agentic-product-standard/blob/main/SCORECARD.md)
[![CI](https://github.com/Moai-Team-LLC/AgenticGateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Moai-Team-LLC/AgenticGateway/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue)](LICENSE)

**The model plane for agentic products.** The reference implementation of the
*Model & provider* (Layer 1) and *Cost & FinOps* (Layer 9) surfaces of the
[Agentic Product Standard](https://github.com/Moai-Team-LLC/agentic-product-standard):
one OpenAI-compatible key for the whole fleet, with measured routing, cost
ceilings, caching, and an evidence trail behind it — on a
[Bifrost](https://github.com/maximhq/bifrost) data plane.

## 🌐 The AgenticProduct ecosystem

| | Member | Role | License |
|---|---|---|---|
| 📐 | [agentic-product-standard](https://github.com/Moai-Team-LLC/agentic-product-standard) | The doctrine: 12 factors, 8-layer harness, autonomy ladder, scorecard | MIT |
| ⚙️ | [AgenticOps](https://github.com/Moai-Team-LLC/AgenticOps) | Runtime & fleet operations — manifests, scheduling, durable backlog, bounded runs, fleet health | Apache-2.0 |
| 🧠 | [AgenticMind](https://github.com/Moai-Team-LLC/AgenticMind) | Auditable knowledge & memory: grounded answers, guardrails, evidence sink | Apache-2.0 |
| 📈 | [AgenticPerformance](https://github.com/Moai-Team-LLC/AgenticPerformance) | Evals & observability: OTel traces, golden-set evals, improvement loop | Apache-2.0 |
| 🩹 | [AgenticSelfHealingCode](https://github.com/Moai-Team-LLC/AgenticSelfHealingCode) | Self-healing: repairs what breaks in production | Apache-2.0 |
| 🌉 | **AgenticGateway** (this repo) | Model & cost plane: one key, measured routing, ceilings, cache, evidence | Apache-2.0 |
| 🛡️ | [AgenticAssurance](https://github.com/Moai-Team-LLC/AgenticAssurance) | Security assurance: red-teams any agent, Cycle-of-Trust policy pack | MIT |

**How they compose.** **AgenticOps** runs the fleet, **AgenticMind** gives
agents auditable knowledge & memory, **AgenticPerformance** measures every run
with traces and evals, and **AgenticSelfHealingCode** repairs what breaks —
closing the **run → remember → measure → heal** loop. **AgenticGateway** is the
model plane every LLM call in that loop passes through — one key, eval-measured
routing, cost ceilings — and **AgenticAssurance** red-teams any agent in the
loop, with the whole stack conforming to the
**[agentic-product-standard](https://github.com/Moai-Team-LLC/agentic-product-standard)**.

## Why

The Standard demands things most stacks leave open: multi-provider from the
start, tiered routing chosen from *measured* performance, per-run cost ceilings
**enforced in code**, cost-per-outcome in the same traces as your evals, and
guardrails on the model boundary. Those two surfaces — *Model & provider* and
*Cost & FinOps* — had no reference substrate. AgenticGateway implements exactly
them, and **only** them:

- **One key.** Agents call one OpenAI-compatible endpoint with one
  `sk-agw-*` key. Tenants, budgets, upstream credentials, routing — all derive
  from it, server-side. Client keys are stored as sha256 only.
- **Bifrost underneath.** Provider abstraction, failover, load-balancing,
  retries, streaming, semantic caching are Bifrost's job (~µs overhead) — this
  repo never re-implements transport, and adding a provider is config, not code.
- **Routing you can audit.** `"model": "agw:reasoning"` resolves against a
  policy built from an AgenticPerformance eval run (`eval_run_id` recorded);
  the ranking becomes Bifrost's fallback chain. Change the eval run → change
  the routing. No hand-guessed model choices, no LLM on the hot path.
- **Cost is a circuit breaker, not a report.** Tenant-window and per-run
  ceilings deny fail-closed the moment they trip; every call lands in a ledger
  (hash-not-text) and as a cost-attributed OTel span in APL's conventions;
  spend anomalies alert and can throttle the key.
- **Composed assurance.** AgenticMind's guard runs inline (vendored verbatim,
  provenance-locked); protected-path tool calls are flagged/denied with
  AgenticAssurance's pack; a sampled APL judge reviews high-risk routes
  asynchronously; every decision emits a hash-not-text evidence event.
- **Fast by contract.** CI fails if the edge adds ≥ 5 ms P50 (cache-miss,
  ex-inference), a cache hit takes ≥ 10 ms, or streaming TTFB gains ≥ 5 ms.
  Measured: ~0.1 ms added overhead.

## Architecture — two planes

```
client ──(one key, OpenAI-compatible)──► AgenticGateway edge (Bun, thin)
                                           │ auth O(1) · guard (sub-ms) ·
                                           │ budgets · route-tag · exact cache
                                           ▼
                                        BIFROST (Go data plane)
                                           │ providers, failover, LB, retries,
                                           │ streaming, semantic cache (~µs)
                                           ▼
                                        model providers
   ┌───────────────────────────────────────────────────────────────────┐
   │ ASYNC ASSURANCE LANE (never blocks the token stream)              │
   │ ledger + budgets · evidence (hash-not-text) → AgenticMind sink    │
   │ cost-per-outcome OTLP spans → AgenticPerformance ingest           │
   │ spend anomaly → alert/throttle · sampled judge on high-risk routes│
   └───────────────────────────────────────────────────────────────────┘
```

The seam is deliberate: everything latency-critical that Bifrost ships natively
stays in Bifrost (config, not Go plugins — see
[ADR-0001](docs/adr/0001-two-plane-seam.md)); the edge adds only cheap
deterministic gates and is CI-benched against the budget.

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.3 and Docker.

```bash
git clone https://github.com/Moai-Team-LLC/AgenticGateway && cd AgenticGateway
bun install

# 1. data plane — put provider keys in .env first (never in config files)
cp .env.example .env               # set OPENAI_API_KEY / ANTHROPIC_API_KEY
echo "AGW_VAULT_KEY=$(openssl rand -hex 32)" >> .env
docker compose -f bifrost/docker-compose.yml up -d
curl -fsS localhost:8080/health

# 2. a tenant with a fail-closed budget (prints the client key ONCE)
bun run src/cli.ts tenant create acme --budget-usd 25

# 3. routing policy from an AgenticPerformance eval export
bun run src/cli.ts routing sync --from-file fixtures/apl-eval-export.example.json

# 4. the edge
bun run dev
```

Then point any OpenAI SDK at it:

```bash
curl -s localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-agw-…" \
  -H "content-type: application/json" \
  -d '{ "model": "agw:reasoning", "messages": [{ "role": "user", "content": "Plan the migration." }] }'
```

`model` accepts a concrete `provider/model` (passthrough), or `agw:<task-class>`
/ `agw:auto` to route by the synced policy — the top-ranked route serves, the
rest of the ranking rides along as Bifrost fallbacks. Optional headers:
`x-agw-run-id` scopes the per-run cost breaker; `traceparent` joins your trace.

**Production hardening:** create per-tenant Bifrost virtual keys (budgets +
rate limits at the data plane too), vault them with
`agw tenant set-upstream acme --secret sk-bf-…`, and set `AGW_REQUIRE_VK=true`.
See [bifrost/README.md](bifrost/README.md).

## What runs where

| Hot path (inline, benched) | Async lane (after the response) |
|---|---|
| Auth: sha256 key → tenant (O(1)) | Request ledger + spend recording |
| Guard: AgenticMind's injection/PII regexes | Evidence event → file JSONL or AgenticMind `/hooks/audit` |
| Budget gate: tenant + run ceilings | Cost-per-outcome OTLP span → APL ingest |
| Route-tag: policy map lookup | Spend-anomaly check → alert / throttle |
| Exact cache lookup (tenant-scoped) | Sampled judge (APL) on high-risk routes |
| Output gates (non-streaming): leak check, protected-path scan | Stream tap: usage + flag-only leak check |

## Delegation, not duplication

| Sibling | What the gateway takes | How |
|---|---|---|
| 🧠 AgenticMind | `guardInput` / PII tagging / output-leak check; the evidence-sink wire contract | vendored verbatim ([provenance-locked](vendor/PROVENANCE.md)); `POST /hooks/audit` sink optional |
| 📈 AgenticPerformance | routing rankings from eval runs; `runJudge` + deterministic sampling; OTel GenAI/`apl.*` trace conventions | eval-export sync ([docs](docs/apl-eval-export.md)); vendored judge runner; OTLP/JSON exporter |
| 🛡️ AgenticAssurance | `protected-paths.json` + matcher for tool-call gating | vendored pack; report/block modes, never auto-approve |
| Bifrost | all transport: providers, failover, LB, retries, streaming, semantic cache, governance VKs | pinned image + `config.json` (GitOps) |

A CI grep gate ([scripts/no-reimpl-check.sh](scripts/no-reimpl-check.sh)) fails
the build if guard/judge/policy logic or a provider SDK ever appears outside
`vendor/`.

## Status — Scorecard mapping

| Gate (Standard) | Where | State |
|---|---|---|
| Per-run token/cost ceiling **in code**, circuit breaker (Cost M2) | `src/cost/budgets.ts` | ✅ tested |
| Prompt/KV caching on stable prefixes; cost-per-task in traces (Cost M2) | `src/cache/exact.ts` + Bifrost semantic cache; `src/cost/otel.ts` | ✅ tested |
| Multi-provider from the start; provider = config (Layer 1) | `bifrost/` | ✅ |
| Tiered routing from measured per-task performance (Layer 1/9) | `src/routing/` | ✅ tested |
| Fail-closed tenancy, hash-not-text, cross-tenant isolation | `src/edge/`, `tests/isolation.test.ts` | ✅ CI-gated |
| Hot-path latency budget | `scripts/bench.ts` | ✅ CI-gated |

Honest gaps and how each maps to the Standard: [CONFORMANCE.md](CONFORMANCE.md).

## Commands

```bash
bun run check     # lint + typecheck + tests + no-reimpl gate
bun run bench     # hot-path latency gates (CI)
bun run dev       # the edge against a local Bifrost
bun run src/cli.ts --help    # tenants, keys, vault, routing, inspect
```

## Docs

- [CLAUDE.md](CLAUDE.md) — the contract for AI coding agents working here
- [ADR-0001 Two-plane seam](docs/adr/0001-two-plane-seam.md) ·
  [ADR-0002 Vendored sibling contracts](docs/adr/0002-vendored-sibling-contracts.md) ·
  [ADR-0003 Vault & virtual keys](docs/adr/0003-vault-and-virtual-keys.md)
- [APL eval export](docs/apl-eval-export.md) — sourcing the routing policy
- [CONFORMANCE.md](CONFORMANCE.md) — Standard mapping + honest gaps
- [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE) © 2026 Moai Team LLC. See [NOTICE](NOTICE) for vendored
sibling attributions.
