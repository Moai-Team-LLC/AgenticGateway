/**
 * Routing policy (FR-9.1): per task-class ranked (provider, model) tuples with
 * cost/latency profile, sourced from AgenticPerformance eval history. The
 * stored document records `source.evalRunId` + `syncedAt`, so every route is
 * traceable to a measured eval run — never a hand-guess.
 */

import type { Database } from "bun:sqlite"

import { err, ok, type Result } from "neverthrow"
import { z } from "zod"

export const rankedRouteSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  passRate: z.number().min(0).max(1).optional(),
  inputPerMTok: z.number().nonnegative().optional(),
  outputPerMTok: z.number().nonnegative().optional(),
  latencyP50Ms: z.number().nonnegative().optional(),
})

export const routingPolicySchema = z
  .object({
    version: z.literal(1),
    source: z.object({
      kind: z.enum(["apl-eval", "fixture", "manual"]),
      evalRunId: z.string().nullable(),
      syncedAt: z.string(),
    }),
    defaultClass: z.string().min(1),
    classes: z.record(
      z.string(),
      z.object({
        ranked: z.array(rankedRouteSchema).min(1),
        highRisk: z.boolean().optional(),
      }),
    ),
  })
  .refine((p) => p.defaultClass in p.classes, {
    message: "defaultClass must exist in classes",
  })

export type RoutingPolicy = z.infer<typeof routingPolicySchema>
export type RankedRoute = z.infer<typeof rankedRouteSchema>

export const savePolicy = (
  db: Database,
  policy: RoutingPolicy,
  tenantId = "*",
): Result<void, string> => {
  const parsed = routingPolicySchema.safeParse(policy)
  if (!parsed.success) return err(`invalid routing policy: ${parsed.error.issues[0]?.message ?? "parse error"}`)
  db.query(
    `INSERT INTO routing_policies (tenant_id, doc, eval_run_id, synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (tenant_id) DO UPDATE SET doc = excluded.doc, eval_run_id = excluded.eval_run_id, synced_at = excluded.synced_at`,
  ).run(tenantId, JSON.stringify(parsed.data), parsed.data.source.evalRunId, Date.now())
  return ok(undefined)
}

/** Tenant override first, then the '*' default; null when neither exists. */
export const loadPolicy = (db: Database, tenantId: string): Result<RoutingPolicy | null, string> => {
  const row =
    db.query<{ doc: string }, [string]>("SELECT doc FROM routing_policies WHERE tenant_id = ?").get(tenantId) ??
    db.query<{ doc: string }, [string]>("SELECT doc FROM routing_policies WHERE tenant_id = ?").get("*")
  if (row === null) return ok(null)
  let doc: unknown
  try {
    doc = JSON.parse(row.doc)
  } catch {
    return err("stored routing policy is not valid JSON — refusing to route on it")
  }
  const parsed = routingPolicySchema.safeParse(doc)
  if (!parsed.success) return err("stored routing policy failed validation — refusing to route on it")
  return ok(parsed.data)
}
