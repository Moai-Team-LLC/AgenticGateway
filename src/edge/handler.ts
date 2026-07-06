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
import { costUsd } from "../cost/pricing"
import type { OtelExporter } from "../cost/otel"
import { guardRequest, guardResponseLeak } from "../delegate/guard"
import { makeJudgeCaller, shouldJudge, type JudgeCaller } from "../delegate/judge"
import { scanCompletionForProtectedPaths } from "../delegate/protected-paths"
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
}

interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
}

const JUDGE_ITEM_MAX_CHARS = 4000
const STREAM_TAP_MAX_CHARS = 262_144
const POLICY_CACHE_TTL_MS = 10_000

const errorResponse = (status: number, code: string, message: string, requestId: string): Response =>
  Response.json(
    { error: { message, type: "agentic_gateway_error", code } },
    { status, headers: { "x-agw-request-id": requestId } },
  )

export const makeChatHandler = (deps: HotDeps): ((req: Request) => Promise<Response>) => {
  const { cfg, db } = deps
  const fetchUpstream = deps.fetchUpstream ?? fetch
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
      return deny(
        429,
        budget.error.code,
        `${budget.error.scope} budget ${budget.error.code === "budget_missing" ? "is not provisioned" : "exceeded"}`,
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
        const inTok = facts.usage?.prompt_tokens ?? null
        const outTok = facts.usage?.completion_tokens ?? null
        const routeUsed = facts.routeUsed ?? decision.model
        const cost =
          facts.cacheHit || inTok === null
            ? { usd: 0, known: true }
            : costUsd(routeUsed, inTok, outTok ?? 0)
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
          costUsd: facts.cacheHit ? 0 : cost.usd,
          latencyMs: facts.latencyMs,
        })
        if (!facts.cacheHit && inTok !== null) {
          recordSpend(db, tenantId, runId, inTok + (outTok ?? 0), cost.usd)
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
          cost_usd: facts.cacheHit ? 0 : cost.usd,
          cache_hit: facts.cacheHit,
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
          costUsd: facts.cacheHit ? 0 : cost.usd,
          outcome: facts.outcome,
          cacheHit: facts.cacheHit,
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
      return deny(500, "vault_error", "upstream credential unavailable", "denied_policy", {
        taskClass: decision.taskClass,
      })
    }
    if (vk.value === null && cfg.requireVk) {
      return deny(403, "no_upstream_credential", "tenant has no vaulted upstream credential", "denied_policy", {
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
              stream_options: { include_usage: true, ...chat.stream_options },
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
      const errText = await upstream.text()
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
      return new Response(errText, {
        status: upstream.status,
        headers: { "content-type": "application/json", "x-agw-request-id": requestId },
      })
    }

    // ── streaming: pass through untouched; tap in the async lane ──
    if (isStream) {
      let tapped = ""
      let usage: Usage | null = null
      const decoder = new TextDecoder()
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          if (tapped.length < STREAM_TAP_MAX_CHARS) tapped += decoder.decode(chunk, { stream: true })
        },
        flush() {
          let text = ""
          for (const line of tapped.split("\n")) {
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue
            try {
              const evt = JSON.parse(line.slice("data: ".length)) as {
                choices?: { delta?: { content?: unknown } }[]
                usage?: Usage
              }
              const delta = evt.choices?.[0]?.delta?.content
              if (typeof delta === "string") text += delta
              if (evt.usage !== undefined && evt.usage !== null) usage = evt.usage
            } catch {
              // partial/foreign SSE lines are fine — tapping is best-effort
            }
          }
          // streamed bytes are already with the client: leak/policy = flag-only
          // (flush runs after the stream closed — already off the hot path)
          finalize({
            latencyMs: latency(),
            outcome: "ok",
            routeUsed: decision.model,
            usage,
            cacheHit: false,
            responseText: text.length > 0 ? text : null,
            protectedFlagged: false,
            protectedHits: [],
            leak: text.length > 0 ? guardResponseLeak(chat.messages, text) : { leaked: false },
            piiKinds: guarded.piiKinds,
          })
        },
      })
      return new Response(upstream.body === null ? null : upstream.body.pipeThrough(tap), {
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

    deps.cache.set(key, completionText)
    scheduleFinalize({
      outcome: "ok",
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
