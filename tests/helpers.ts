/**
 * Test kit: an in-memory edge (real handler, injected upstream fetch,
 * capturing evidence/otel) plus request/response builders. Also used by
 * scripts/bench.ts so the bench exercises the same wiring the tests prove.
 */

import type { Database } from "bun:sqlite"

import { makeExactCache } from "../src/cache/exact"
import { ensureTenantBudget } from "../src/cost/budgets"
import type { SpanFacts } from "../src/cost/otel"
import type { EvidenceEvent } from "../src/delegate/evidence"
import type { JudgeCaller } from "../src/delegate/judge"
import type { Config } from "../src/kernel/config"
import { openDb } from "../src/kernel/db"
import { makeAuthenticator } from "../src/edge/auth"
import { makeFetchHandler, type EdgeDeps } from "../src/edge/server"
import { savePolicy, type RoutingPolicy } from "../src/routing/policy"
import { createTenant, makeVaultReader, setUpstreamSecret } from "../src/vault/vault"

export const TEST_VAULT_KEY = "f".repeat(64)

export const testConfig = (over: Partial<Config> = {}): Config => ({
  port: 0,
  dbPath: ":memory:",
  bifrostUrl: "http://bifrost.test",
  vaultKey: TEST_VAULT_KEY,
  adminToken: undefined,
  requireVk: false,
  runLimitUsd: 5,
  guardMaxChars: 512_000,
  cacheTtlMs: 300_000,
  cacheMaxEntries: 1024,
  evidenceSink: "off",
  evidenceFile: "/dev/null",
  auditUrl: undefined,
  auditToken: undefined,
  judgeSampleRate: 0,
  judgeModel: "openai/gpt-4o-mini",
  protectedPathMode: "report",
  anomalyFactor: 5,
  anomalyThrottle: false,
  aplIngestUrl: undefined,
  aplIngestToken: undefined,
  ...over,
})

export const fixturePolicy: RoutingPolicy = {
  version: 1,
  source: { kind: "fixture", evalRunId: "fixture-run-1", syncedAt: "2026-07-06T00:00:00Z" },
  defaultClass: "default",
  classes: {
    default: { ranked: [{ provider: "openai", model: "gpt-4o-mini", passRate: 0.92 }] },
    reasoning: {
      ranked: [
        { provider: "anthropic", model: "claude-sonnet-4-5", passRate: 0.97 },
        { provider: "openai", model: "gpt-4.1", passRate: 0.93 },
      ],
      highRisk: true,
    },
  },
}

export const completionJson = (
  opts: {
    content?: string
    model?: string
    usage?: { prompt_tokens: number; completion_tokens: number }
    toolCalls?: unknown[]
  } = {},
): Record<string, unknown> => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  model: opts.model ?? "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: opts.content ?? "hello there",
        ...(opts.toolCalls === undefined ? {} : { tool_calls: opts.toolCalls }),
      },
      finish_reason: "stop",
    },
  ],
  usage: opts.usage ?? { prompt_tokens: 10, completion_tokens: 5 },
})

export interface UpstreamCall {
  url: string
  headers: Record<string, string>
  body: unknown
}

export interface TestEdge {
  cfg: Config
  db: Database
  handler: (req: Request) => Promise<Response>
  clientKey: string
  tenantId: string
  keyId: string
  calls: UpstreamCall[]
  events: EvidenceEvent[]
  spans: SpanFacts[]
}

export const setupEdge = (
  opts: {
    cfg?: Partial<Config>
    upstream?: (url: string, init: RequestInit) => Response | Promise<Response>
    /** null = no policy stored; undefined = the fixture policy. */
    policy?: RoutingPolicy | null
    vkSecret?: string
    judge?: JudgeCaller
  } = {},
): TestEdge => {
  const cfg = testConfig(opts.cfg)
  const db = openDb(":memory:")
  const created = createTenant(db, "acme")._unsafeUnwrap()
  ensureTenantBudget(db, created.tenantId, { limitUsd: 100, windowMs: 24 * 60 * 60 * 1000 })
  if (opts.policy !== null) savePolicy(db, opts.policy ?? fixturePolicy)._unsafeUnwrap()
  if (opts.vkSecret !== undefined) {
    setUpstreamSecret(db, TEST_VAULT_KEY, created.tenantId, opts.vkSecret)._unsafeUnwrap()
  }

  const calls: UpstreamCall[] = []
  const events: EvidenceEvent[] = []
  const spans: SpanFacts[] = []
  const upstream = opts.upstream ?? (() => Response.json(completionJson()))
  const fetchUpstream = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v
    calls.push({
      url: String(url),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    })
    return upstream(String(url), init ?? {})
  }) as typeof fetch

  const deps: EdgeDeps = {
    cfg,
    db,
    authenticate: makeAuthenticator(db),
    cache: makeExactCache({ ttlMs: cfg.cacheTtlMs, maxEntries: cfg.cacheMaxEntries }),
    readVault: makeVaultReader(db, cfg.vaultKey, 0), // ttl 0 in tests: always fresh
    evidence: {
      emit: (e) => {
        events.push(e)
      },
      flush: async () => undefined,
      dropped: 0,
    },
    otel: {
      record: (f) => {
        spans.push(f)
      },
      flush: async () => undefined,
      dropped: 0,
    },
    fetchUpstream,
    ...(opts.judge === undefined ? {} : { judge: opts.judge }),
  }
  return {
    cfg,
    db,
    handler: makeFetchHandler(deps),
    clientKey: created.clientKey,
    tenantId: created.tenantId,
    keyId: created.keyId,
    calls,
    events,
    spans,
  }
}

export const chatReq = (
  clientKey: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request("http://edge.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(clientKey === null ? {} : { authorization: `Bearer ${clientKey}` }),
      ...headers,
    },
    body: JSON.stringify(body),
  })

export const simpleChat = (model = "openai/gpt-4o-mini", user = "hi, how are you?"): unknown => ({
  model,
  messages: [{ role: "user", content: user }],
})

/** The async assurance lane runs on setTimeout(0) — give it a beat. */
export const flushAsyncLane = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

export const ledgerRow = (db: Database, requestId: string): Record<string, unknown> | null =>
  db.query<Record<string, unknown>, [string]>("SELECT * FROM request_ledger WHERE id = ?").get(requestId)
