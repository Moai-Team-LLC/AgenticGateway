/**
 * The hot path (FR-1.1 + the L9 inline gates). Order and cost per step:
 *   auth (sha256 + one prepared read) → guard (vendored regexes, sub-ms) →
 *   budgets (prepared reads) → route-tag (map lookup) → exact-cache lookup →
 *   forward to Bifrost. Everything else — ledger, spend, evidence, OTel,
 *   anomaly, sampled judge — runs in the async lane after the response (or
 *   after the stream closes) and never blocks the token stream.
 * Every denial is fail-closed and every path lands one ledger row and one
 * evidence event, with sha256 references only — never raw text.
 */

import type { Database } from "bun:sqlite"

import { z } from "zod"

import { cacheKey, type ExactCache } from "../cache/exact"
import { checkSpendAnomaly, throttleKey } from "../cost/anomaly"
import { checkBudgets, recordSpend } from "../cost/budgets"
import { recordLedger, setJudgeVerdict, type LedgerEntry } from "../cost/ledger"
import {
  cacheAdjustedCostUsd,
  cacheSavingsRatio,
  DEFAULT_PRICES,
  type Price,
  type TokenSplit,
} from "../cost/pricing"
import type { OtelExporter } from "../cost/otel"
import { guardRequest, guardResponseLeak } from "../delegate/guard"
import { makeJudgeCaller, shouldJudge, type JudgeCaller } from "../delegate/judge"
import { scanCompletionForProtectedPaths, scanToolCalls } from "../delegate/protected-paths"
import type { EvidenceEmitter } from "../delegate/evidence"
import type { Config } from "../kernel/config"
import { newUuid, sha256hex } from "../kernel/crypto"
import { log } from "../kernel/log"
import { loadPolicy, type RoutingPolicy } from "../routing/policy"
import { resolveRoute } from "../routing/select"
import type { VaultReader } from "../vault/vault"
import type { Authenticator } from "./auth"

const chatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()).min(1),
    stream: z.boolean().optional(),
    fallbacks: z.array(z.string()).optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough()

type ChatRequest = z.infer<typeof chatRequestSchema>

export interface HotDeps {
  cfg: Config
  db: Database
  authenticate: Authenticator
  cache: ExactCache
  readVault: VaultReader
  evidence: EvidenceEmitter
  otel: OtelExporter
  judge?: JudgeCaller
  fetchUpstream?: typeof fetch
  /** Price table (route → USD/MTok). Defaults to the checked-in table. */
  prices?: Record<string, Price>
}

interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  /** OpenAI prompt-cache detail (cached_tokens is a SUBSET of prompt_tokens). */
  prompt_tokens_details?: { cached_tokens?: number }
  /** Anthropic-shaped usage (some Bifrost passthroughs): input_tokens EXCLUDES cache. */
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Normalize a provider usage object into a cache-role split, across OpenAI + Anthropic
 * shapes. OpenAI: prompt_tokens includes cached_tokens (read), no explicit write. Anthropic:
 * input_tokens excludes cache; read/write are separate fields. */
const splitUsage = (u: Usage | null | undefined): TokenSplit => {
  if (u === null || u === undefined) return { freshInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
  const output = u.completion_tokens ?? u.output_tokens ?? 0
  if (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
    return {
      freshInput: u.input_tokens ?? u.prompt_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output,
    }
  }
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0
  return { freshInput: Math.max(0, prompt - cacheRead), cacheWrite: 0, cacheRead, output }
}

const hasUsageTokens = (u: Usage | null | undefined): boolean =>
  u !== null && u !== undefined && (u.prompt_tokens !== undefined || u.input_tokens !== undefined)

const JUDGE_ITEM_MAX_CHARS = 4000
/** Bounds the leak/judge text and per-call tool-call JSON kept from a stream —
 *  NOT the usage capture (that is parsed incrementally, frame by frame). */
const STREAM_TAP_MAX_CHARS = 262_144
const POLICY_CACHE_TTL_MS = 10_000

interface ReconstructedToolCall {
  name: string
  args: string
}

interface SseTapResult {
  text: string
  usage: Usage | null
  toolCalls: ReconstructedToolCall[]
}

/**
 * Incremental SSE reader for a streamed chat completion. Parses each complete
 * `data:` line as it arrives so the trailing `usage` frame is always captured
 * regardless of stream length; accumulates assistant text (bounded) for the
 * leak/judge checks and reassembles streamed tool-call deltas (index-keyed,
 * bounded) for the protected-path scan.
 */
const makeSseTap = (): { push(chunk: Uint8Array): void; result(): SseTapResult } => {
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  let usage: Usage | null = null
  const toolByIndex = new Map<number, { name: string; args: string }>()

  const handleLine = (line: string): void => {
    if (!line.startsWith("data: ") || line === "data: [DONE]") return
    let evt: {
      choices?: { delta?: { content?: unknown; tool_calls?: unknown[] } }[]
      usage?: Usage
    }
    try {
      evt = JSON.parse(line.slice("data: ".length))
    } catch {
      return // partial/foreign SSE lines are fine — tapping is best-effort
    }
    const delta = evt.choices?.[0]?.delta
    if (typeof delta?.content === "string" && text.length < STREAM_TAP_MAX_CHARS) text += delta.content
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls as {
        index?: number
        function?: { name?: unknown; arguments?: unknown }
      }[]) {
        const idx = typeof tc.index === "number" ? tc.index : 0
        const cur = toolByIndex.get(idx) ?? { name: "", args: "" }
        if (typeof tc.function?.name === "string") cur.name += tc.function.name
        if (typeof tc.function?.arguments === "string" && cur.args.length < STREAM_TAP_MAX_CHARS) {
          cur.args += tc.function.arguments
        }
        toolByIndex.set(idx, cur)
      }
    }
    if (evt.usage !== undefined && evt.usage !== null) usage = evt.usage
  }

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl).trimEnd())
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
      }
    },
    result() {
      if (buffer.length > 0) handleLine(buffer.trimEnd())
      return {
        text,
        usage,
        toolCalls: [...toolByIndex.values()]
          .filter((t) => t.name.length > 0)
          .map((t) => ({ name: t.name, args: t.args })),
      }
    },
  }
}

const errorResponse = (status: number, code: string, message: string, requestId: string): Response =>
  Response.json(
    { error: { message, type: "agentic_gateway_error", code } },
    { status, headers: { "x-agw-request-id": requestId } },
  )

export const makeChatHandler = (deps: HotDeps): ((req: Request) => Promise<Response>) => {
  const { cfg, db } = deps
  const fetchUpstream = deps.fetchUpstream ?? fetch
  const prices = deps.prices ?? DEFAULT_PRICES
  const judge = deps.judge ?? makeJudgeCaller({ bifrostUrl: cfg.bifrostUrl, model: cfg.judgeModel })
  const policyCache = new Map<string, { policy: RoutingPolicy | null; at: number }>()

  const policyFor = (tenantId: string): RoutingPolicy | null | undefined => {
    const hit = policyCache.get(tenantId)
    if (hit !== undefined && Date.now() - hit.at < POLICY_CACHE_TTL_MS) return hit.policy
    const loaded = loadPolicy(db, tenantId)
    if (loaded.isErr()) return undefined // corrupted stored policy → fail closed at call site
    policyCache.set(tenantId, { policy: loaded.value, at: Date.now() })
    return loaded.value
  }

  return async (req) => {
    const requestId = newUuid()
    const startMs = Date.now()
    const t0 = performance.now()
    const traceparent = req.headers.get("traceparent")
    const runId = req.headers.get("x-agw-run-id")

    // ── auth: tenant + identity from the key, O(1), fail-closed ──
    const principal = deps.authenticate(req.headers.get("authorization"))
    if (principal.isErr()) {
      return errorResponse(principal.error.status, principal.error.code, "access denied", requestId)
    }
    const { tenantId, keyId } = principal.value

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return errorResponse(400, "invalid_json", "request body is not valid JSON", requestId)
    }
    const parsed = chatRequestSchema.safeParse(body)
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid request", requestId)
    }
    const chat: ChatRequest = parsed.data
    const inputHash = sha256hex(JSON.stringify(chat.messages))
    const latency = (): number => performance.now() - t0

    const ledgerBase = {
      id: requestId,
      tenantId,
      keyId,
      runId,
      model: chat.model,
      inputHash,
      protectedPathFlag: false,
      cacheHit: false,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    }

    const deny = (
      status: number,
      code: string,
      message: string,
      outcome: LedgerEntry["outcome"],
      extras: { guardTags?: string[]; event?: "GuardBlock" | "OutputLeak"; taskClass?: string | null },
    ): Response => {
      const guardTags = extras.guardTags ?? []
      recordLedger(db, {
        ...ledgerBase,
        taskClass: extras.taskClass ?? null,
        route: null,
        outcome,
        guardTags,
        latencyMs: latency(),
      })
      deps.evidence.emit({
        event: extras.event ?? "GatewayRequest",
        session_id: runId ?? requestId,
        tool: "chat.completions",
        decision: "deny",
        tenant_id: tenantId,
        input_hash: inputHash,
        outcome,
        reason: code,
        tags: guardTags,
      })
      return errorResponse(status, code, message, requestId)
    }

    // ── inline guard (vendored AgenticMind; sub-ms) ──
    const guarded = guardRequest(chat.messages, cfg.guardMaxChars)
    if (!guarded.verdict.ok) {
      return deny(400, "guard_blocked", guarded.verdict.reason ?? "blocked by guard", "denied_guard", {
        guardTags: guarded.verdict.tags,
        event: "GuardBlock",
      })
    }

    // ── budgets: tenant + run ceilings, fail-closed circuit breaker ──
    const budget = checkBudgets(db, tenantId, runId, cfg.runLimitUsd)
    if (budget.isErr()) {
      // 429 (retryable) only for an exceeded ceiling; a missing budget is an
      // operator config error → 403, so SDKs don't retry-storm against it.
      const missing = budget.error.code === "budget_missing"
      return deny(
        missing ? 403 : 429,
        budget.error.code,
        `${budget.error.scope} budget ${missing ? "is not provisioned" : "exceeded"}`,
        "denied_budget",
        {},
      )
    }

    // ── route-tag: cheap upfront decision, no LLM ──
    const policy = policyFor(tenantId)
    if (policy === undefined) {
      return deny(500, "routing_policy_corrupt", "stored routing policy failed validation", "denied_policy", {})
    }
    const route = resolveRoute(policy, chat.model)
    if (route.isErr()) {
      return deny(400, route.error.code, route.error.message, "denied_policy", {})
    }
    const decision = route.value
    const provider = decision.model.includes("/") ? (decision.model.split("/")[0] as string) : "unknown"

    const forwardBody: Record<string, unknown> = { ...chat, model: decision.model }
    if (decision.fallbacks.length > 0 && chat.fallbacks === undefined) {
      forwardBody["fallbacks"] = decision.fallbacks
    }
    const isStream = chat.stream === true
    const normalized = JSON.stringify(forwardBody)

    interface FinalizeFacts {
      outcome: LedgerEntry["outcome"]
      routeUsed: string | null
      usage: Usage | null
      cacheHit: boolean
      responseText: string | null
      protectedFlagged: boolean
      protectedHits: string[]
      leak: { leaked: boolean; reason?: string }
      piiKinds: string[]
      latencyMs: number
    }

    const finalize = (facts: FinalizeFacts): void => {
      try {
        const routeUsed = facts.routeUsed ?? decision.model
        const split = splitUsage(facts.usage)
        const metered = !facts.cacheHit && hasUsageTokens(facts.usage)
        // Total input across the cache split (OpenAI prompt_tokens already includes cached).
        const inTok = hasUsageTokens(facts.usage)
          ? split.freshInput + split.cacheWrite + split.cacheRead
          : null
        const outTok = hasUsageTokens(facts.usage) ? split.output : null
        // A cache hit costs $0 (real); a served response whose usage never arrived is
        // UNMETERED — record NULL cost (never a silent zero) and warn. Cost is
        // CACHE-ADJUSTED: a provider prompt-cache read is billed ≈−90%, so a flat
        // total-token cost overstates spend ~6× when cache-read dominates.
        const costUsdValue: number | null = facts.cacheHit
          ? 0
          : inTok === null
            ? null
            : cacheAdjustedCostUsd(routeUsed, split, prices).usd
        const cacheSavings: number | null = metered ? cacheSavingsRatio(routeUsed, split, prices) : null
        if (!facts.cacheHit && inTok === null && (facts.outcome === "ok" || facts.outcome === "client_aborted")) {
          log("warn", "unmetered_response", { request_id: requestId, route: routeUsed, outcome: facts.outcome })
        }
        recordLedger(db, {
          ...ledgerBase,
          taskClass: decision.taskClass,
          route: routeUsed,
          outcome: facts.outcome,
          guardTags: facts.piiKinds.map((k) => `pii:${k}`),
          protectedPathFlag: facts.protectedFlagged,
          cacheHit: facts.cacheHit,
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: costUsdValue,
          cacheReadTokens: metered ? split.cacheRead : null,
          cacheWriteTokens: metered ? split.cacheWrite : null,
          cacheSavingsRatio: cacheSavings,
          latencyMs: facts.latencyMs,
        })
        if (metered) {
          recordSpend(db, tenantId, runId, (inTok ?? 0) + (outTok ?? 0), costUsdValue ?? 0)
        }
        deps.evidence.emit({
          event: "GatewayRequest",
          session_id: runId ?? requestId,
          tool: "chat.completions",
          decision: "allow",
          tenant_id: tenantId,
          input_hash: inputHash,
          route: routeUsed,
          outcome: facts.outcome,
          tokens: inTok === null ? undefined : inTok + (outTok ?? 0),
          ...(costUsdValue === null ? {} : { cost_usd: costUsdValue }),
          cache_hit: facts.cacheHit,
          ...(cacheSavings === null ? {} : { cache_savings_ratio: cacheSavings }),
          tags: facts.piiKinds.map((k) => `pii:${k}`),
        } as Parameters<EvidenceEmitter["emit"]>[0])
        if (facts.protectedFlagged) {
          deps.evidence.emit({
            event: "ProtectedPathFlag",
            session_id: runId ?? requestId,
            tool: "chat.completions",
            decision: cfg.protectedPathMode === "block" ? "deny" : "flag",
            tenant_id: tenantId,
            input_hash: inputHash,
            tags: facts.protectedHits,
          })
        }
        if (facts.leak.leaked) {
          deps.evidence.emit({
            event: "OutputLeak",
            session_id: runId ?? requestId,
            tool: "chat.completions",
            decision: facts.outcome === "denied_output" ? "deny" : "flag",
            tenant_id: tenantId,
            input_hash: inputHash,
            reason: facts.leak.reason ?? "leak",
          })
        }
        deps.otel.record({
          traceparent,
          tenantId,
          route: routeUsed,
          requestedModel: chat.model,
          provider,
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: costUsdValue,
          outcome: facts.outcome,
          cacheHit: facts.cacheHit,
          cacheSavingsRatio: cacheSavings,
          cacheReadTokens: metered ? split.cacheRead : null,
          startMs,
          endMs: Date.now(),
        })
        // spend anomaly (deterministic, ledger-driven)
        const anomaly = checkSpendAnomaly(db, keyId, cfg.anomalyFactor)
        if (anomaly.anomalous) {
          log("warn", "spend_anomaly", {
            key_id: keyId,
            recent_usd: anomaly.recentUsd,
            baseline_per_5m_usd: anomaly.baselinePer5mUsd,
          })
          deps.evidence.emit({
            event: "SpendAnomaly",
            session_id: runId ?? requestId,
            tool: "chat.completions",
            decision: cfg.anomalyThrottle ? "deny" : "flag",
            tenant_id: tenantId,
            reason: `recent=$${anomaly.recentUsd.toFixed(4)} baseline5m=$${anomaly.baselinePer5mUsd.toFixed(4)}`,
          })
          if (cfg.anomalyThrottle) throttleKey(db, keyId)
        }
        // sampled judge — async, high-risk only, never the hot path
        const highRisk = decision.highRisk || facts.protectedFlagged
        if (facts.responseText !== null && shouldJudge(requestId, highRisk, cfg.judgeSampleRate)) {
          const vk = deps.readVault(tenantId)
          void judge({
            requestId,
            itemText: facts.responseText.slice(0, JUDGE_ITEM_MAX_CHARS),
            vkSecret: vk.isOk() ? vk.value : null,
          })
            .then((verdict) => {
              setJudgeVerdict(db, requestId, verdict)
              deps.evidence.emit({
                event: "JudgeVerdict",
                session_id: runId ?? requestId,
                tool: "chat.completions",
                decision: verdict === "pass" ? "allow" : "flag",
                tenant_id: tenantId,
                outcome: verdict,
                route: routeUsed,
              })
            })
            .catch((e: unknown) => {
              log("warn", "judge_failed", { request_id: requestId, error: String(e) })
            })
        }
      } catch (e) {
        log("error", "finalize_failed", { request_id: requestId, error: String(e) })
      }
    }

    /** Async lane: latency is captured at response time, the work runs after it. */
    const scheduleFinalize = (facts: Omit<FinalizeFacts, "latencyMs">): void => {
      const latencyMs = latency()
      setTimeout(() => finalize({ ...facts, latencyMs }), 0)
    }

    // ── exact cache: short-circuits before any provider call ──
    const key = cacheKey(tenantId, normalized)
    if (!isStream) {
      const hit = deps.cache.get(key)
      if (hit !== null) {
        scheduleFinalize({
          outcome: "cache_hit",
          routeUsed: decision.model,
          usage: null,
          cacheHit: true,
          responseText: null,
          protectedFlagged: false,
          protectedHits: [],
          leak: { leaked: false },
          piiKinds: guarded.piiKinds,
        })
        return new Response(hit, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-agw-request-id": requestId,
            "x-agw-route": decision.model,
            "x-agw-cache": "hit",
          },
        })
      }
    }

    // ── upstream credential from the vault (never exposed to the client) ──
    const vk = deps.readVault(tenantId)
    if (vk.isErr()) {
      return deny(500, "vault_error", "upstream credential unavailable", "denied_vault", {
        taskClass: decision.taskClass,
      })
    }
    if (vk.value === null && cfg.requireVk) {
      return deny(403, "no_upstream_credential", "tenant has no vaulted upstream credential", "denied_vault", {
        taskClass: decision.taskClass,
      })
    }

    // ── forward through Bifrost (the only provider path) ──
    let upstream: Response
    try {
      upstream = await fetchUpstream(`${cfg.bifrostUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(vk.value === null ? {} : { authorization: `Bearer ${vk.value}` }),
          // tenant-scoped key activates Bifrost's semantic cache per tenant
          "x-bf-cache-key": `tenant:${tenantId}`,
          ...(traceparent === null ? {} : { traceparent }),
        },
        body: isStream
          ? JSON.stringify({
              ...forwardBody,
              // gateway metering is non-overridable: our flag wins over the client's.
              stream_options: { ...chat.stream_options, include_usage: true },
            })
          : normalized,
      })
    } catch (e) {
      log("error", "upstream_unreachable", { request_id: requestId, error: String(e) })
      scheduleFinalize({
        outcome: "upstream_error",
        routeUsed: decision.model,
        usage: null,
        cacheHit: false,
        responseText: null,
        protectedFlagged: false,
        protectedHits: [],
        leak: { leaked: false },
        piiKinds: guarded.piiKinds,
      })
      return errorResponse(502, "upstream_unreachable", "data plane unreachable", requestId)
    }

    if (!upstream.ok) {
      // never echo an upstream error body verbatim — it may carry provider
      // detail or secrets. Reference it by hash (hash-not-text) and return a
      // sanitized gateway error.
      const errText = await upstream.text()
      const latencyMs = latency()
      setTimeout(
        () =>
          finalize({
            latencyMs,
            outcome: "upstream_error",
            routeUsed: decision.model,
            usage: null,
            cacheHit: false,
            responseText: null,
            protectedFlagged: false,
            protectedHits: [],
            leak: { leaked: false },
            piiKinds: guarded.piiKinds,
          }),
        0,
      )
      log("warn", "upstream_error", { request_id: requestId, status: upstream.status, body_hash: sha256hex(errText) })
      return errorResponse(
        upstream.status >= 500 ? 502 : upstream.status,
        "upstream_error",
        "the data plane returned an error",
        requestId,
      )
    }

    // ── streaming: pass through byte-identical; meter + gate in the async
    //    lane. A manual ReadableStream (not a TransformStream) so finalize
    //    fires on EVERY termination — normal close, upstream error mid-stream,
    //    and client abort — never silently unmetered. Usage is parsed
    //    incrementally so the trailing usage frame is captured on streams of
    //    any length; only the leak/judge text and tool-call JSON are bounded. ──
    if (isStream) {
      if (upstream.body === null) {
        scheduleFinalize({
          outcome: "ok",
          routeUsed: decision.model,
          usage: null,
          cacheHit: false,
          responseText: null,
          protectedFlagged: false,
          protectedHits: [],
          leak: { leaked: false },
          piiKinds: guarded.piiKinds,
        })
        return new Response(null, {
          status: upstream.status,
          headers: { "x-agw-request-id": requestId, "x-agw-route": decision.model, "x-agw-cache": "miss" },
        })
      }
      const reader = upstream.body.getReader()
      const parser = makeSseTap()
      let done = false
      const settle = (outcome: LedgerEntry["outcome"]): void => {
        if (done) return
        done = true
        const tap = parser.result()
        const scan = scanToolCalls(tap.toolCalls)
        scheduleFinalize({
          outcome,
          routeUsed: decision.model,
          usage: tap.usage,
          cacheHit: false,
          responseText: tap.text.length > 0 ? tap.text : null,
          // streamed bytes are already with the client: policy/leak = flag-only
          protectedFlagged: scan.flagged,
          protectedHits: scan.hits,
          leak: tap.text.length > 0 ? guardResponseLeak(chat.messages, tap.text) : { leaked: false },
          piiKinds: guarded.piiKinds,
        })
      }
      const streamBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done: streamDone, value } = await reader.read()
            if (streamDone) {
              controller.close()
              settle("ok")
              return
            }
            controller.enqueue(value)
            parser.push(value)
          } catch (e) {
            log("warn", "stream_upstream_error", { request_id: requestId, error: String(e) })
            controller.error(e)
            settle("upstream_error")
          }
        },
        cancel(reason) {
          void reader.cancel(reason)
          settle("client_aborted")
        },
      })
      return new Response(streamBody, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
          "x-agw-request-id": requestId,
          "x-agw-route": decision.model,
          "x-agw-cache": "miss",
        },
      })
    }

    // ── non-streaming: output gates, cache store, async lane ──
    const completionText = await upstream.text()
    let completion: unknown
    try {
      completion = JSON.parse(completionText)
    } catch {
      completion = null
    }
    const c = completion as {
      usage?: Usage
      choices?: { message?: { content?: unknown } }[]
      model?: string
    } | null
    const responseText =
      typeof c?.choices?.[0]?.message?.content === "string" ? c.choices[0]!.message!.content : ""
    const routeUsed =
      typeof c?.model === "string" && c.model.length > 0
        ? c.model.includes("/")
          ? c.model
          : `${provider}/${c.model}`
        : decision.model

    const leak = responseText.length > 0 ? guardResponseLeak(chat.messages, responseText) : { leaked: false as const }
    const scan = scanCompletionForProtectedPaths(completion)

    if (leak.leaked) {
      scheduleFinalize({
        outcome: "denied_output",
        routeUsed,
        usage: c?.usage ?? null,
        cacheHit: false,
        responseText,
        protectedFlagged: scan.flagged,
        protectedHits: scan.hits,
        leak,
        piiKinds: guarded.piiKinds,
      })
      return errorResponse(502, "output_leak", `response blocked: ${leak.reason ?? "system-prompt leak"}`, requestId)
    }
    if (scan.flagged && cfg.protectedPathMode === "block") {
      scheduleFinalize({
        outcome: "denied_output",
        routeUsed,
        usage: c?.usage ?? null,
        cacheHit: false,
        responseText,
        protectedFlagged: true,
        protectedHits: scan.hits,
        leak,
        piiKinds: guarded.piiKinds,
      })
      return errorResponse(403, "protected_path", "tool call reaches a protected control path", requestId)
    }

    // Only cache a well-formed completion; never store a body we could not
    // parse (it would be replayed as a bogus "success" and skew analytics).
    if (completion !== null) deps.cache.set(key, completionText)
    scheduleFinalize({
      outcome: completion === null ? "upstream_error" : "ok",
      routeUsed,
      usage: c?.usage ?? null,
      cacheHit: false,
      responseText: responseText.length > 0 ? responseText : null,
      protectedFlagged: scan.flagged,
      protectedHits: scan.hits,
      leak,
      piiKinds: guarded.piiKinds,
    })
    return new Response(completionText, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-agw-request-id": requestId,
        "x-agw-route": routeUsed,
        "x-agw-cache": "miss",
      },
    })
  }
}
