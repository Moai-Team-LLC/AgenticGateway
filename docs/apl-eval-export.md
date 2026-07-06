# Sourcing the routing policy from AgenticPerformance

`agw routing sync --from-file <export.json>` builds the routing policy from an
**APL eval export** — measured per-task-class model performance, never a
hand-guess. The stored policy records `source.evalRunId` + `syncedAt`, so every
routing decision is traceable to the eval run that produced it.

## Why a file (v0.1)

AgenticPerformance deliberately ships no read API yet (its scorecard is a pure
in-memory projection; "exposed later as REST/JSON + MCP tools"). Until
`@apl/sdk` lands, the interchange is a JSON export an operator produces from
APL's Postgres. This keeps the two repos coupled only by a documented wire
shape — the family's "optional adapters, never hard dependencies" rule.

## Export shape

```json
{
  "evalRunId": "<apl_eval_run.id>",
  "exportedAt": "2026-07-01T12:00:00Z",
  "entries": [
    {
      "taskClass": "reasoning",
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "passRate": 0.97,
      "total": 40,
      "costPerMTokIn": 3,
      "costPerMTokOut": 15,
      "latencyP50Ms": 1200,
      "highRisk": true
    }
  ]
}
```

Semantics (validated by `src/routing/sync.ts`):

- `model` should be APL's **pinned** `model_snapshot_id` — never a floating
  alias (APL's own invariant).
- Entries with `total: 0` are dropped; an export where every entry is empty is
  refused outright — APL's "empty suite = hard fail, never green" rule carries
  over.
- Ranking per class: `passRate` desc, then `costPerMTokOut` asc, then
  `latencyP50Ms` asc. The winner serves; the rest become Bifrost `fallbacks`.
- `highRisk: true` on any entry marks the whole class high-risk — those routes
  get sampled-judge coverage (`AGW_JUDGE_SAMPLE_RATE`).

## Producing it from APL's Postgres

APL stores eval runs in `apl_eval_run` (per agent version) and cases in
`apl_eval_case` (task classes live in its `tags text[]`); the model dimension
is `apl_agent_version.model_snapshot_id`. A starting-point query — adapt the
tag→class mapping and time window to your fleet:

```sql
-- one row per (task-class tag, model snapshot): latest eval runs, aggregated
SELECT
  t.tag                             AS "taskClass",
  v.model_snapshot_id               AS "model",
  AVG(r.pass_rate)                  AS "passRate",
  SUM(r.total)::int                 AS "total"
FROM apl_eval_run r
JOIN apl_agent_version v ON v.id = r.agent_version_id
JOIN LATERAL (
  SELECT DISTINCT unnest(c.tags) AS tag
  FROM apl_eval_case c
  WHERE c.agent_id = r.agent_id AND c.case_set_hash = r.case_set_hash
) t ON true
WHERE r.created_at > now() - interval '30 days'
GROUP BY t.tag, v.model_snapshot_id;
```

Then wrap the rows into the export shape, filling:

- `evalRunId` — the id of the newest `apl_eval_run` included (it is recorded in
  the gateway's `routing_policies.eval_run_id`);
- `provider` — the provider that serves each `model_snapshot_id` through your
  Bifrost config (APL pins snapshots but does not store providers — this
  mapping is yours);
- cost/latency columns — from your price table / APL span timings, optional.

Note APL's RLS: connect with `app.current_tenant` set for the tenant you are
exporting.

## Verifying the P3 gate

`tests/budgets-routing.test.ts` proves the Standard's gate end-to-end on the
fixture: building policies from two different eval runs produces different
routing, and the stored policy always names its eval run.
