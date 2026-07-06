# Security Policy

## Supported versions

AgenticGateway is pre-1.0; security fixes land on the latest `0.x` minor.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or PR.

Use GitHub's private vulnerability reporting: the repository's **Security** tab →
**Report a vulnerability**. We aim to acknowledge within 5 business days and to
share a remediation timeline after triage.

Helpful details: affected version or commit, reproduction steps, and impact.
Coordinated disclosure is appreciated.

## Scope notes

AgenticGateway sits on the credential and spend boundary of an agent fleet —
the design assumes that boundary is hostile:

- **Client keys** are random 192-bit tokens stored as sha256 only; possession
  of the database does not yield usable keys.
- **Upstream credentials** (Bifrost virtual keys) are AES-256-GCM-encrypted at
  rest under `AGW_VAULT_KEY` and are never sent to clients or written to logs,
  traces, ledger rows, or evidence events (tests assert this).
- **Fail-closed everywhere:** missing key/tenant/budget, unknown task class,
  vault errors, and output-leak detections deny rather than degrade open.
- **Hash-not-text:** prompts and responses never persist anywhere in the
  control plane — `input_hash` (sha256) is the only reference.
- **Tenant isolation** across keys, budgets, cache, vault, routing, ledger,
  and evidence is CI-gated (`tests/isolation.test.ts`).
- The **guard** (prompt-injection/PII, vendored from AgenticMind) is a
  deterministic regex layer — treat it as defense-in-depth on the model
  boundary, not a substitute for output handling in your product.

Out of scope: vulnerabilities in Bifrost itself (report to
[maximhq/bifrost](https://github.com/maximhq/bifrost)) and in model providers.
