/**
 * Hot-path latency bench (NFR-1, CI-gated). Measures the edge's ADDED
 * overhead — client→edge→mock-upstream vs client→mock-upstream directly —
 * with the production wiring (makeEdgeDeps): real HTTP on localhost, real
 * SQLite, real guard/budget/route/cache steps. Gates:
 *   - P50 added overhead on cache-miss  < 5 ms   (ex-inference)
 *   - P50 cache-hit total               < 10 ms
 *   - streaming time-to-first-byte added overhead < 5 ms (async lane never
 *     blocks the token stream)
 */

import { ensureTenantBudget } from "../src/cost/budgets"
import { makeEdgeDeps, makeFetchHandler } from "../src/edge/server"
import { savePolicy } from "../src/routing/policy"
import { createTenant } from "../src/vault/vault"
import { completionJson, fixturePolicy, testConfig } from "../tests/helpers"

const WARMUP = 30
const N = 200

const p50 = (xs: number[]): number => {
  const s = [...xs].toSorted((a, b) => a - b)
  return s[Math.floor(s.length / 2)] as number
}

const sse = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } })}`,
  "data: [DONE]",
  "",
].join("\n\n")

const upstream = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = (await req.json()) as { stream?: boolean }
    if (body.stream === true) {
      return new Response(sse, { headers: { "content-type": "text/event-stream" } })
    }
    return Response.json(completionJson())
  },
})

const cfg = testConfig({ bifrostUrl: `http://localhost:${upstream.port}` })
const deps = makeEdgeDeps(cfg) // in-memory db via cfg.dbPath = ":memory:"
const created = createTenant(deps.db, "bench")._unsafeUnwrap()
ensureTenantBudget(deps.db, created.tenantId, { limitUsd: 10_000 })
savePolicy(deps.db, fixturePolicy)._unsafeUnwrap()

const edge = Bun.serve({ port: 0, fetch: makeFetchHandler(deps) })

const edgeUrl = `http://localhost:${edge.port}/v1/chat/completions`
const directUrl = `http://localhost:${upstream.port}/v1/chat/completions`

const body = (i: number, stream = false): string =>
  JSON.stringify({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: `bench message ${i}` }],
    ...(stream ? { stream: true } : {}),
  })

const post = async (url: string, payload: string, auth: boolean): Promise<number> => {
  const t0 = performance.now()
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${created.clientKey}` } : {}),
    },
    body: payload,
  })
  await res.arrayBuffer()
  if (res.status !== 200) throw new Error(`bench got ${res.status}: ${url}`)
  return performance.now() - t0
}

const ttfb = async (url: string, payload: string, auth: boolean): Promise<number> => {
  const t0 = performance.now()
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${created.clientKey}` } : {}),
    },
    body: payload,
  })
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  const t = performance.now() - t0
  await reader.cancel()
  return t
}

// warmup both paths
for (let i = 0; i < WARMUP; i++) {
  await post(directUrl, body(i), false)
  await post(edgeUrl, body(1_000_000 + i), true)
}

const direct: number[] = []
for (let i = 0; i < N; i++) direct.push(await post(directUrl, body(i), false))

const miss: number[] = []
for (let i = 0; i < N; i++) miss.push(await post(edgeUrl, body(2_000_000 + i), true))

// prime one entry, then hit it
await post(edgeUrl, body(42), true)
const hit: number[] = []
for (let i = 0; i < N; i++) hit.push(await post(edgeUrl, body(42), true))

const directTtfb: number[] = []
const edgeTtfb: number[] = []
for (let i = 0; i < 50; i++) {
  directTtfb.push(await ttfb(directUrl, body(i, true), false))
  edgeTtfb.push(await ttfb(edgeUrl, body(3_000_000 + i, true), true))
}

// let the async assurance lane drain before tearing down the shared db
await new Promise((r) => setTimeout(r, 50))
upstream.stop()
edge.stop()
await deps.evidence.flush()
await deps.otel.flush()
deps.db.close()

const overheadMs = p50(miss) - p50(direct)
const hitMs = p50(hit)
const streamOverheadMs = p50(edgeTtfb) - p50(directTtfb)

console.log(
  JSON.stringify(
    {
      p50_direct_ms: +p50(direct).toFixed(3),
      p50_edge_miss_ms: +p50(miss).toFixed(3),
      p50_added_overhead_ms: +overheadMs.toFixed(3),
      p50_cache_hit_ms: +hitMs.toFixed(3),
      p50_stream_ttfb_added_ms: +streamOverheadMs.toFixed(3),
      gates: { overhead_lt_5ms: overheadMs < 5, hit_lt_10ms: hitMs < 10, stream_ttfb_lt_5ms: streamOverheadMs < 5 },
    },
    null,
    2,
  ),
)

if (overheadMs >= 5 || hitMs >= 10 || streamOverheadMs >= 5) {
  console.error("BENCH GATE FAILED: hot-path latency budget exceeded (NFR-1)")
  process.exit(1)
}
console.log("bench: within budget")
