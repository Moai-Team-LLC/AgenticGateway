# ADR-0003: The vault maps client keys to per-tenant Bifrost virtual keys

**Status:** accepted · 2026-07-06

## Context

FR-1.3 requires: one client key → many upstream provider keys, per-tenant, with
rotation, and clients must never see upstream credentials. Bifrost already
ships the per-tenant upstream primitive natively: **virtual keys** (`sk-bf-*`)
carry provider configs (weights, allowed models → automatic failover chains),
budgets, and rate limits, while raw provider keys stay env-ref'd inside the
data plane and never touch this repo at all.

## Decision

Three credential tiers, each crossing exactly one boundary:

1. **Client key `sk-agw-*`** (edge boundary): random 192-bit, shown once at
   issue, stored as sha256. Tenant + identity derive from it (FR-1.4) — never
   from model output.
2. **Bifrost virtual key `sk-bf-*`** (data-plane boundary): one per tenant,
   created by the operator in Bifrost governance, vaulted here with AES-256-GCM
   under `AGW_VAULT_KEY`, decrypted only into the Bifrost request header (with
   a short in-memory TTL cache to keep the hot path at a Map lookup). Rotation
   inserts a new active row (`rotated_from` chain, old row kept for audit) —
   no client change.
3. **Provider keys** (provider boundary): live only as env refs in Bifrost's
   config; the control plane never stores or sees them.

Local/dev mode runs Bifrost without governance: no VK exists, the edge forwards
unauthenticated to localhost. `AGW_REQUIRE_VK=true` (production) makes a
missing vaulted credential a fail-closed 403.

**Billing scope (SRS Q5):** the gateway does **enforcement + telemetry** —
ceilings, ledger, cost-per-outcome traces, anomaly. Chargeback/invoicing is
downstream of the ledger and out of scope; Bifrost VK budgets add a second,
data-plane enforcement layer for defense in depth.

## Consequences

- Budgets are enforced twice on purpose (edge code = the Standard's "in code"
  circuit breaker + VK budget at the data plane); the edge is authoritative for
  fail-closed semantics because it also covers tenants without VKs.
- `AGW_VAULT_KEY` is the root secret; it lives in env (`dotenvx` for encrypted
  env files), never in the store. Losing it means re-vaulting VKs — acceptable
  for v0.1 (VKs are re-issuable), documented in SECURITY.md scope.
- VK provisioning itself stays manual/operator-side (Bifrost UI or governance
  API) — the CLI vaults what you give it and does not orchestrate Bifrost,
  keeping the control plane off Bifrost's admin surface.
