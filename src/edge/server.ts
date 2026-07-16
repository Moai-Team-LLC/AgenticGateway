/**
 * Edge server wiring. Routes:
 *   POST /v1/chat/completions — the one-key OpenAI-compatible entry (hot path)
 *   GET  /health              — liveness
 *   GET  /admin/{ledger,budgets,policy} — read-only introspection (FR-I.2);
 *        requires AGW_ADMIN_TOKEN (unset = 404, fail-closed). Mutations happen
 *        only via the CLI, which audits them as evidence events.
 */

import type { Database } from "bun:sqlite"

import { makeExactCache } from "../cache/exact"
import { costPerVerifiedOutcome } from "../cost/ledger"
import { makeOtelExporter, type OtelExporter } from "../cost/otel"
import { loadPrices, type Price } from "../cost/pricing"
import { makeEvidenceEmitter, type EvidenceEmitter } from "../delegate/evidence"
import type { Config } from "../kernel/config"
import { constantTimeEq } from "../kernel/crypto"
import { openDb } from "../kernel/db"
import { log } from "../kernel/log"
import { makeVaultReader } from "../vault/vault"
import { makeAuthenticator } from "./auth"
import { makeChatHandler, type HotDeps } from "./handler"

const json = (status: number, body: unknown): Response => Response.json(body, { status })

const adminHandler = (cfg: Config, db: Database, path: string, req: Request): Response => {
  if (cfg.adminToken === undefined) return json(404, { error: "not found" })
  const auth = req.headers.get("authorization")
  if (auth === null || !auth.startsWith("Bearer ") || !constantTimeEq(auth.slice(7), cfg.adminToken)) {
    return json(401, { error: "unauthorized" })
  }
  if (path === "/admin/ledger") {
    const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? "50") || 50, 500)
    const rows = db
      .query("SELECT * FROM request_ledger ORDER BY created_at DESC LIMIT ?")
      .all(limit)
    return json(200, { rows })
  }
  if (path === "/admin/budgets") {
    return json(200, { rows: db.query("SELECT * FROM budgets").all() })
  }
  if (path === "/admin/policy") {
    return json(200, {
      rows: db.query("SELECT tenant_id, eval_run_id, synced_at, doc FROM routing_policies").all(),
    })
  }
  if (path === "/admin/cost-per-verified") {
    // The cost/quality-plane headline: cache-adjusted $ per verify-passing outcome.
    const params = new URL(req.url).searchParams
    const tenant = params.get("tenant")
    const since = Number(params.get("since"))
    return json(200, {
      ...costPerVerifiedOutcome(db, {
        ...(tenant === null ? {} : { tenantId: tenant }),
        ...(Number.isFinite(since) && since > 0 ? { sinceMs: since } : {}),
      }),
    })
  }
  return json(404, { error: "not found" })
}

export interface EdgeDeps extends HotDeps {
  db: Database
}

export const makeEdgeDeps = (
  cfg: Config,
  overrides: Partial<Pick<HotDeps, "fetchUpstream" | "judge">> & {
    db?: Database
    evidence?: EvidenceEmitter
    otel?: OtelExporter
  } = {},
): EdgeDeps => {
  const db = overrides.db ?? openDb(cfg.dbPath)
  let prices: Record<string, Price> | undefined
  if (cfg.priceFile !== undefined) {
    const loaded = loadPrices(cfg.priceFile)
    if (loaded.isErr()) {
      log("warn", "price_file_ignored", { path: cfg.priceFile, error: loaded.error })
    } else {
      prices = loaded.value
    }
  }
  return {
    cfg,
    db,
    authenticate: makeAuthenticator(db),
    cache: makeExactCache({ ttlMs: cfg.cacheTtlMs, maxEntries: cfg.cacheMaxEntries }),
    readVault: makeVaultReader(db, cfg.vaultKey),
    evidence: overrides.evidence ?? makeEvidenceEmitter(cfg),
    otel: overrides.otel ?? makeOtelExporter({ url: cfg.aplIngestUrl, token: cfg.aplIngestToken }),
    ...(prices === undefined ? {} : { prices }),
    ...(overrides.judge === undefined ? {} : { judge: overrides.judge }),
    ...(overrides.fetchUpstream === undefined ? {} : { fetchUpstream: overrides.fetchUpstream }),
  }
}

/** The routing fetch handler — exported separately so tests drive it in-process. */
export const makeFetchHandler = (deps: EdgeDeps): ((req: Request) => Promise<Response>) => {
  const chat = makeChatHandler(deps)
  return async (req) => {
    const path = new URL(req.url).pathname
    if (req.method === "POST" && path === "/v1/chat/completions") return chat(req)
    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return json(200, { ok: true, service: "agentic-gateway" })
    }
    if (req.method === "GET" && path.startsWith("/admin/")) {
      return adminHandler(deps.cfg, deps.db, path, req)
    }
    return json(404, { error: "not found" })
  }
}

export const startServer = (cfg: Config): { stop: () => Promise<void>; port: number } => {
  const deps = makeEdgeDeps(cfg)
  const server = Bun.serve({ port: cfg.port, fetch: makeFetchHandler(deps) })
  log("info", "gateway_listening", { port: cfg.port, bifrost: cfg.bifrostUrl })
  return {
    port: cfg.port,
    stop: async () => {
      await deps.evidence.flush()
      await deps.otel.flush()
      server.stop()
      deps.db.close()
    },
  }
}
