/**
 * Cost-per-outcome traces (FR-9.4): OTLP/JSON spans in the SAME conventions
 * AgenticPerformance ingests — OTel GenAI semconv keyed on
 * `gen_ai.operation.name`, identity on the Resource (`apl.tenant_id`,
 * `apl.product_id`), cost as `apl.cost_usd` (an `apl.*` key survives every
 * APL normalization path and lands queryable in `apl_span.attributes`).
 * Joins the caller's W3C `traceparent` when present, so gateway spans are
 * siblings of the agent's own APL spans. Async lane only; a dead collector
 * drops spans, never requests.
 */

import { randomBytes } from "node:crypto"

export interface SpanFacts {
  traceparent: string | null
  tenantId: string
  route: string
  requestedModel: string
  provider: string
  inputTokens: number | null
  outputTokens: number | null
  /** Cache-adjusted $ (honest under provider prompt caching). */
  costUsd: number | null
  outcome: string
  cacheHit: boolean
  /** 1 − cache-adjusted/nominal cost — how much prompt caching saved this call. */
  cacheSavingsRatio?: number | null
  /** Provider prompt-cache read tokens (≈ −90% price). */
  cacheReadTokens?: number | null
  startMs: number
  endMs: number
}

export interface OtelExporter {
  record(facts: SpanFacts): void
  flush(): Promise<void>
  readonly dropped: number
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

type AttrValue = string | number | boolean

const attr = (key: string, value: AttrValue): Record<string, unknown> => ({
  key,
  value:
    typeof value === "string"
      ? { stringValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : Number.isInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value },
})

const toSpan = (f: SpanFacts): Record<string, unknown> => {
  const parent = f.traceparent === null ? null : TRACEPARENT_RE.exec(f.traceparent)
  const attributes = [
    attr("gen_ai.operation.name", "chat"),
    attr("gen_ai.request.model", f.route.includes("/") ? (f.route.split("/")[1] as string) : f.route),
    attr("gen_ai.provider.name", f.provider),
    attr("apl.cost_usd", f.costUsd ?? 0),
    attr("apl.outcome", f.outcome),
    attr("apl.route", f.route),
    attr("apl.requested_model", f.requestedModel),
    attr("apl.cache_hit", f.cacheHit),
  ]
  if (f.inputTokens !== null) attributes.push(attr("gen_ai.usage.input_tokens", f.inputTokens))
  if (f.outputTokens !== null) attributes.push(attr("gen_ai.usage.output_tokens", f.outputTokens))
  if (f.cacheSavingsRatio !== null && f.cacheSavingsRatio !== undefined)
    attributes.push(attr("apl.cache_savings_ratio", f.cacheSavingsRatio))
  if (f.cacheReadTokens !== null && f.cacheReadTokens !== undefined)
    attributes.push(attr("gen_ai.usage.cache_read_input_tokens", f.cacheReadTokens))
  return {
    traceId: parent === null ? randomBytes(16).toString("hex") : parent[1],
    spanId: randomBytes(8).toString("hex"),
    ...(parent === null ? {} : { parentSpanId: parent[2] }),
    name: `chat ${f.route}`,
    kind: 3, // SPAN_KIND_CLIENT
    startTimeUnixNano: String(Math.round(f.startMs * 1e6)),
    endTimeUnixNano: String(Math.round(f.endMs * 1e6)),
    attributes,
    status: { code: f.outcome === "ok" || f.outcome === "cache_hit" ? 1 : 2 },
  }
}

export const makeOtelExporter = (opts: {
  url: string | undefined
  token: string | undefined
  flushEvery?: number
  /** Time-based flush so low-traffic spans don't linger until shutdown. 0 disables. */
  flushIntervalMs?: number
  fetchImpl?: typeof fetch
}): OtelExporter => {
  if (opts.url === undefined) {
    return { record: () => undefined, flush: async () => undefined, dropped: 0 }
  }
  const url = opts.url
  const flushEvery = opts.flushEvery ?? 20
  const flushIntervalMs = opts.flushIntervalMs ?? 5000
  const fetchImpl = opts.fetchImpl ?? fetch
  const byTenant = new Map<string, Record<string, unknown>[]>()
  let queued = 0
  let dropped = 0

  const flush = async (): Promise<void> => {
    if (queued === 0) return
    const resourceSpans = [...byTenant.entries()].map(([tenantId, spans]) => ({
      resource: {
        attributes: [
          attr("service.name", "agentic-gateway"),
          attr("apl.tenant_id", tenantId),
          attr("apl.product_id", "agentic-gateway"),
        ],
      },
      scopeSpans: [{ scope: { name: "agentic-gateway" }, spans }],
    }))
    byTenant.clear()
    const count = queued
    queued = 0
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` }),
        },
        body: JSON.stringify({ resourceSpans }),
      })
      if (!res.ok) dropped += count
    } catch {
      dropped += count // best-effort: telemetry loss never fails a request
    }
  }

  const timer =
    flushIntervalMs > 0
      ? (setInterval(() => void flush(), flushIntervalMs) as ReturnType<typeof setInterval> & { unref?: () => void })
      : null
  timer?.unref?.() // never keep the process alive for telemetry

  return {
    record(facts) {
      const spans = byTenant.get(facts.tenantId) ?? []
      spans.push(toSpan(facts))
      byTenant.set(facts.tenantId, spans)
      queued += 1
      if (queued >= flushEvery) void flush()
    },
    flush,
    get dropped() {
      return dropped
    },
  }
}
