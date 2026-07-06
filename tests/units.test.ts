import { describe, expect, test } from "bun:test"

import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeExactCache, cacheKey } from "../src/cache/exact"
import { checkSpendAnomaly, throttleKey } from "../src/cost/anomaly"
import { recordLedger } from "../src/cost/ledger"
import { makeOtelExporter } from "../src/cost/otel"
import { makeEvidenceEmitter } from "../src/delegate/evidence"
import { makeJudgeCaller, shouldJudge } from "../src/delegate/judge"
import { scanCompletionForProtectedPaths } from "../src/delegate/protected-paths"
import { openDb } from "../src/kernel/db"
import { makeAuthenticator } from "../src/edge/auth"
import { createTenant } from "../src/vault/vault"
import { completionJson } from "./helpers"

describe("cache/exact", () => {
  test("hit, TTL expiry, LRU eviction", async () => {
    const cache = makeExactCache({ ttlMs: 50, maxEntries: 2 })
    cache.set("a", "1")
    expect(cache.get("a")).toBe("1")
    await new Promise((r) => setTimeout(r, 60))
    expect(cache.get("a")).toBeNull()
    cache.set("a", "1")
    cache.set("b", "2")
    cache.set("c", "3") // evicts oldest
    expect(cache.size).toBe(2)
    expect(cache.get("a")).toBeNull()
  })

  test("cache keys are tenant-scoped", () => {
    expect(cacheKey("tenant-a", '{"m":1}')).not.toBe(cacheKey("tenant-b", '{"m":1}'))
  })
})

describe("edge/auth", () => {
  test("derives tenant from the key; denies missing/unknown/disabled", () => {
    const db = openDb(":memory:")
    const created = createTenant(db, "acme")._unsafeUnwrap()
    const auth = makeAuthenticator(db)
    expect(auth(`Bearer ${created.clientKey}`)._unsafeUnwrap().tenantId).toBe(created.tenantId)
    expect(auth(null)._unsafeUnwrapErr().status).toBe(401)
    expect(auth("Bearer sk-agw-wrong")._unsafeUnwrapErr().code).toBe("unknown_key")
    db.query("UPDATE gateway_keys SET disabled = 1").run()
    expect(auth(`Bearer ${created.clientKey}`).isErr()).toBe(true)
  })

  test("throttled key is denied with 429", () => {
    const db = openDb(":memory:")
    const created = createTenant(db, "acme")._unsafeUnwrap()
    throttleKey(db, created.keyId)
    const auth = makeAuthenticator(db)
    expect(auth(`Bearer ${created.clientKey}`)._unsafeUnwrapErr()).toEqual({ status: 429, code: "key_throttled" })
  })
})

const seedLedgerCost = (db: ReturnType<typeof openDb>, keyId: string, usd: number, atMsAgo: number): void => {
  recordLedger(db, {
    id: crypto.randomUUID(),
    tenantId: "t",
    keyId,
    runId: null,
    taskClass: null,
    model: "m",
    route: "openai/gpt-4o-mini",
    inputHash: "h",
    outcome: "ok",
    guardTags: [],
    protectedPathFlag: false,
    cacheHit: false,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: usd,
    latencyMs: 1,
  })
  db.query("UPDATE request_ledger SET created_at = ? WHERE cost_usd = ? AND created_at > ?").run(
    Date.now() - atMsAgo,
    usd,
    Date.now() - 1000,
  )
}

describe("cost/anomaly", () => {
  test("a synthetic spend spike alerts; steady spend does not", () => {
    const db = openDb(":memory:")
    // steady baseline: ~$0.05 per 5-minute bucket over the trailing hour
    for (let i = 1; i <= 11; i++) seedLedgerCost(db, "k1", 0.05, i * 5 * 60 * 1000)
    expect(checkSpendAnomaly(db, "k1", 5).anomalous).toBe(false)
    // spike: $3 in the last 5 minutes ≫ 5× baseline
    seedLedgerCost(db, "k1", 3, 60 * 1000)
    const verdict = checkSpendAnomaly(db, "k1", 5)
    expect(verdict.anomalous).toBe(true)
    expect(verdict.recentUsd).toBeGreaterThan(2.9)
  })

  test("cold keys need to clear the hard floor", () => {
    const db = openDb(":memory:")
    seedLedgerCost(db, "k2", 0.3, 60 * 1000) // no baseline, modest spend → no alert
    expect(checkSpendAnomaly(db, "k2", 5).anomalous).toBe(false)
    seedLedgerCost(db, "k2", 1.5, 30 * 1000)
    expect(checkSpendAnomaly(db, "k2", 5).anomalous).toBe(true)
  })
})

describe("cost/otel", () => {
  const facts = {
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    tenantId: "t1",
    route: "openai/gpt-4o-mini",
    requestedModel: "agw:auto",
    provider: "openai",
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.001,
    outcome: "ok",
    cacheHit: false,
    startMs: Date.now() - 100,
    endMs: Date.now(),
  }

  test("emits OTLP/JSON in APL's conventions: GenAI keys + apl.* attrs, joined trace", async () => {
    const bodies: unknown[] = []
    const exporter = makeOtelExporter({
      url: "http://apl.test/v1/traces",
      token: "tok",
      flushEvery: 1,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    exporter.record(facts)
    await exporter.flush()
    const body = bodies[0] as {
      resourceSpans: {
        resource: { attributes: { key: string; value: Record<string, unknown> }[] }
        scopeSpans: { spans: { traceId: string; parentSpanId?: string; attributes: { key: string }[] }[] }[]
      }[]
    }
    const rs = body.resourceSpans[0]
    const resourceKeys = rs?.resource.attributes.map((a) => a.key)
    expect(resourceKeys).toContain("apl.tenant_id")
    expect(resourceKeys).toContain("apl.product_id")
    const span = rs?.scopeSpans[0]?.spans[0]
    expect(span?.traceId).toBe("0123456789abcdef0123456789abcdef")
    expect(span?.parentSpanId).toBe("0123456789abcdef")
    const keys = span?.attributes.map((a) => a.key) ?? []
    expect(keys).toContain("gen_ai.operation.name")
    expect(keys).toContain("gen_ai.usage.input_tokens")
    expect(keys).toContain("apl.cost_usd")
  })

  test("a dead collector drops spans without failing", async () => {
    const exporter = makeOtelExporter({
      url: "http://apl.test/v1/traces",
      token: undefined,
      flushEvery: 1,
      fetchImpl: (async () => {
        throw new Error("connection refused")
      }) as unknown as typeof fetch,
    })
    exporter.record(facts)
    await exporter.flush()
    expect(exporter.dropped).toBe(1)
  })

  test("unset URL is a noop exporter", async () => {
    const exporter = makeOtelExporter({ url: undefined, token: undefined })
    exporter.record(facts)
    await exporter.flush()
    expect(exporter.dropped).toBe(0)
  })
})

describe("delegate/evidence", () => {
  test("file sink writes hash-not-text JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agw-evidence-"))
    const file = join(dir, "evidence.jsonl")
    const emitter = makeEvidenceEmitter({
      evidenceSink: "file",
      evidenceFile: file,
      auditUrl: undefined,
      auditToken: undefined,
    })
    emitter.emit({
      event: "GatewayRequest",
      session_id: "run-1",
      tool: "chat.completions",
      decision: "allow",
      tenant_id: "t1",
      input_hash: "abc123",
      route: "openai/gpt-4o-mini",
    })
    await emitter.flush()
    expect(existsSync(file)).toBe(true)
    const line = JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, unknown>
    expect(line["event"]).toBe("GatewayRequest")
    expect(line["source"]).toBe("agentic-gateway")
    expect(line["input_hash"]).toBe("abc123")
    expect(JSON.stringify(line)).not.toContain("hello") // no payload text fields exist
  })

  test("http sink posts the /hooks/audit wire shape with a bearer", async () => {
    const posted: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = []
    const emitter = makeEvidenceEmitter(
      { evidenceSink: "http", evidenceFile: "", auditUrl: "http://mind.test/hooks/audit", auditToken: "tok" },
      (async (url: unknown, init?: RequestInit) => {
        posted.push({
          url: String(url),
          auth: ((init?.headers ?? {}) as Record<string, string>)["authorization"],
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({ ok: true, id: "x" }), { status: 202 })
      }) as unknown as typeof fetch,
    )
    emitter.emit({ event: "GuardBlock", session_id: "s", tool: "chat.completions", decision: "deny" })
    await emitter.flush()
    expect(posted[0]?.url).toBe("http://mind.test/hooks/audit")
    expect(posted[0]?.auth).toBe("Bearer tok")
    expect(posted[0]?.body["event"]).toBe("GuardBlock") // parseHookEvent keys off `event`
    expect(emitter.dropped).toBe(0)
  })

  test("a dead sink counts drops but never throws", async () => {
    const emitter = makeEvidenceEmitter(
      { evidenceSink: "http", evidenceFile: "", auditUrl: "http://mind.test/hooks/audit", auditToken: undefined },
      (async () => {
        throw new Error("down")
      }) as unknown as typeof fetch,
    )
    emitter.emit({ event: "GatewayRequest", session_id: null, tool: "t", decision: "allow" })
    await emitter.flush()
    expect(emitter.dropped).toBe(1)
  })
})

describe("delegate/judge", () => {
  test("sampling is deterministic and high-risk-only", () => {
    expect(shouldJudge("req-1", false, 1)).toBe(false)
    expect(shouldJudge("req-1", true, 0)).toBe(false)
    expect(shouldJudge("req-1", true, 1)).toBe(true)
    // deterministic: same id → same decision
    expect(shouldJudge("req-x", true, 0.5)).toBe(shouldJudge("req-x", true, 0.5))
  })

  test("judge calls route through Bifrost and parse PASS/FAIL", async () => {
    const urls: string[] = []
    const judge = makeJudgeCaller({
      bifrostUrl: "http://bifrost.test",
      model: "openai/gpt-4o-mini",
      fetchImpl: (async (url: unknown) => {
        urls.push(String(url))
        return Response.json(completionJson({ content: "PASS\nlooks supported" }))
      }) as unknown as typeof fetch,
    })
    const verdict = await judge({ requestId: "r1", itemText: "answer", vkSecret: "sk-bf-x" })
    expect(verdict).toBe("pass")
    expect(urls[0]).toBe("http://bifrost.test/v1/chat/completions")
  })

  test("an erroring judge has NOT endorsed — verdict is fail", async () => {
    const judge = makeJudgeCaller({
      bifrostUrl: "http://bifrost.test",
      model: "openai/gpt-4o-mini",
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    })
    expect(await judge({ requestId: "r1", itemText: "answer", vkSecret: null })).toBe("fail")
  })
})

describe("delegate/protected-paths", () => {
  test("flags tool calls that reach protected control paths", () => {
    const completion = completionJson({
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Write", arguments: JSON.stringify({ file_path: "/repo/.claude/settings.json" }) },
        },
        {
          id: "call_2",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: "rm -rf .claude/hooks/" }) },
        },
      ],
    })
    const scan = scanCompletionForProtectedPaths(completion)
    expect(scan.flagged).toBe(true)
    expect(scan.hits).toContain("Write:path")
    expect(scan.hits).toContain("Bash:shell")
  })

  test("benign tool calls pass", () => {
    const completion = completionJson({
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Write", arguments: JSON.stringify({ file_path: "/repo/src/app.ts" }) },
        },
      ],
    })
    expect(scanCompletionForProtectedPaths(completion).flagged).toBe(false)
  })

  test("plain completions without tool calls pass", () => {
    expect(scanCompletionForProtectedPaths(completionJson()).flagged).toBe(false)
  })
})
