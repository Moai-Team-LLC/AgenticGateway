# Contributing to AgenticGateway

Thanks for your interest. AgenticGateway is the reference implementation of the
[Agentic Product Standard](https://github.com/Moai-Team-LLC/agentic-product-standard)
*Model & provider* + *Cost & FinOps* surfaces — one OpenAI-compatible key for an
agent fleet, with measured routing, cost ceilings, caching, and evidence, on a
Bifrost data plane.

## Development

Requires [Bun](https://bun.sh) ≥ 1.3 (and Docker for a live data plane).

```bash
bun install
bun run check     # oxlint + strict tsc + bun test + no-reimpl gate — THE gate
bun run bench     # hot-path latency gates (also in CI)
```

Read [CLAUDE.md](CLAUDE.md) first — it is the working contract for humans too.
The invariants that will bounce a PR:

- **No transport.** Provider I/O goes through Bifrost; a provider SDK or a
  direct provider URL in the control plane fails `scripts/no-reimpl-check.sh`.
- **No second guard/judge/policy.** Sibling logic lives under `vendor/`
  (verbatim, provenance-locked — see [vendor/PROVENANCE.md](vendor/PROVENANCE.md));
  never edit a vendored file, re-sync it.
- **Two lanes.** Nothing slow or fallible on the hot path; the bench gate must
  stay green. LLM calls (judging) are async/sampled only.
- **Fail-closed + hash-not-text.** New failure modes deny, and never log raw
  payloads or keys — reference by sha256.
- **Every new failure mode becomes a permanent test.**

## Pull requests

- Keep changes small and focused — one concern per PR.
- Add or update tests for any behavior change; `bun run check` must pass.
- Match the surrounding style (functional TS, `neverthrow` Results, `zod` on
  boundaries); prefer the minimum that solves the problem.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint (husky locally, CI on PRs): `type(scope): description`, header
≤ 72 chars — e.g. `feat(routing): …`, `fix(vault): …`.

## Security

Vulnerabilities: see [SECURITY.md](SECURITY.md) — private reporting only.
