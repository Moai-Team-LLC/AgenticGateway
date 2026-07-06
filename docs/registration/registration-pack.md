# Registration pack — adding AgenticGateway to the family (T6.4)

Registering a new member is a **6-repo + org-profile operation** (the
convention has no single machine-readable registry). This pack contains the
ready-to-paste texts. Emoji: **🌉**. Canonical position: between 🩹
AgenticSelfHealingCode and 🛡️ AgenticAssurance. All edits target each repo's
`origin/main` (note: some local checkouts are stale / on feature branches).

## 1. agentic-product-standard — ECOSYSTEM.md

Row for the "Surface → reference implementation" table:

```markdown
| Model & provider + Cost & FinOps (Layer 1 + Layer 9) | AgenticGateway | https://github.com/Moai-Team-LLC/AgenticGateway | Public, actively developed, pre-1.0 (v0.1.0) | Apache-2.0 | Public |
```

Bullet for "How they compose":

```markdown
- **AgenticGateway is the model plane.** Every LLM call in the loop flows
  through its one OpenAI-compatible key: routing chosen from AgenticPerformance
  eval runs, per-run/tenant cost ceilings enforced in code, caching at the data
  plane, and a hash-not-text evidence event per call into AgenticMind's sink —
  on a Bifrost data plane it configures rather than re-implements.
```

## 2. agentic-product-standard — README family table

Row (canonical order — insert before AgenticAssurance):

```markdown
| 🌉 | [AgenticGateway](https://github.com/Moai-Team-LLC/AgenticGateway) | Model & cost plane: one key, measured routing, ceilings, cache, evidence | Apache-2.0 |
```

Wording updates in the same section: "five reference implementations" → "six
reference implementations"; extend the intro sentence with "**AgenticGateway**
*carries* every model call". The compose paragraph gains:
"**AgenticGateway** is the model plane those calls flow through" (see §6 for
the full canonical paragraph).

## 3. agentic-product-standard — SCORECARD.md

The Cost section already exists (its three M2 items are the gateway's core
gates). Layer 1 has no section yet — per the AgenticOps "Fleet operations"
precedent (new section + one paragraph in the corresponding STANDARD.md layer),
propose:

```markdown
### Model & provider *(if calls fan out over multiple models/providers)*

- [ ] **(M2)** All model calls go through one provider-abstraction point; adding a provider is config, not code.
- [ ] **(M2)** Model selection per task class is sourced from measured eval results, and the source eval run is recorded.
- [ ] **(M2)** Clients hold exactly one credential; upstream provider keys are vaulted and never reach clients or logs.
- [ ] **(M3)** Tenant-scoped budgets, cache, and routing with a cross-tenant leakage test in CI.
```

Paired STANDARD.md Layer 1 paragraph:

```markdown
The reference implementation of this layer (together with Layer 9) is
**AgenticGateway** — one OpenAI-compatible key on a Bifrost data plane:
eval-sourced tiered routing, a key vault, prompt + semantic caching, and
per-run cost circuit breakers, with every call emitting hash-not-text evidence.
The `SCORECARD.md` *Model & provider* section gates this;
`examples/agenticgateway-case-study.md` maps each gate to a module.
```

Paved-road note (after line 7): append AgenticGateway to the family list.

## 4. agentic-product-standard — reference-stack skill

Table row for "Surface → what to run":

```markdown
| Model & provider + Cost & FinOps (Layers 1 + 9) | **[AgenticGateway](https://github.com/Moai-Team-LLC/AgenticGateway)** | One OpenAI-compatible key → Bifrost data plane; eval-sourced routing, cost circuit breakers, evidence per call | Bun + SQLite (+ Docker for Bifrost) |
```

Install section:

````markdown
## AgenticGateway — the model & cost surface

```bash
git clone https://github.com/Moai-Team-LLC/AgenticGateway && cd AgenticGateway
bun install
cp .env.example .env && echo "AGW_VAULT_KEY=$(openssl rand -hex 32)" >> .env
docker compose -f bifrost/docker-compose.yml up -d
bun run src/cli.ts tenant create my-team --budget-usd 25
bun run src/cli.ts routing sync --from-file fixtures/apl-eval-export.example.json
bun run dev   # point any OpenAI SDK at :8787 with the printed sk-agw-* key
```

**Bring your own if:** you already run a gateway (LiteLLM, Portkey, raw
Bifrost) and only need the Standard's gates — then keep it and satisfy the
Cost/Model items your own way; AgenticGateway is the paved road, not a lock-in.
````

Also extend the skill's YAML `description` frontmatter to name AgenticGateway
as a trigger (CI requires `name:` + `description:` in the first 10 lines).

## 5. examples/agenticgateway-case-study.md (new file in the standard repo)

Use `docs/registration/case-study.md` from this repo verbatim.

## 6. All six sibling READMEs + the org `.github` profile

Per the canonical cross-link standard (2026-07-06): every family README carries
the identical "## 🌐 The AgenticProduct ecosystem" section listing ALL members
in fixed order (self-row bold, no link). Add the 🌉 row from §2 to each, switch
"five reference implementations" → "six", and use this compose paragraph
everywhere:

```markdown
**How they compose.** **AgenticOps** runs the fleet, **AgenticMind** gives
agents auditable knowledge & memory, **AgenticPerformance** measures every run
with traces and evals, and **AgenticSelfHealingCode** repairs what breaks —
closing the **run → remember → measure → heal** loop. **AgenticGateway** is the
model plane every LLM call in that loop passes through — one key, eval-measured
routing, cost ceilings — and **AgenticAssurance** red-teams any agent in the
loop, with the whole stack conforming to the
**[agentic-product-standard](https://github.com/Moai-Team-LLC/agentic-product-standard)**.
```

Repos to touch: `agentic-product-standard`, `AgenticOps`, `AgenticMind`,
`AgenticPerformance`, `AgenticSelfHealingCode`, `AgenticAssurance`, and the
org profile repo (`.github`).
