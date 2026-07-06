/**
 * Route selection (FR-9.1) — a cheap upfront decision: a map lookup, never an
 * LLM call. Clients either pass a concrete "provider/model" (passthrough) or
 * ask the policy with "agw:<task-class>" / "agw:auto"; the top-ranked route
 * wins and the rest of the ranking becomes Bifrost's `fallbacks` chain.
 * Unknown class or no policy = fail-closed error, not a silent default.
 */

import { err, ok, type Result } from "neverthrow"

import type { RoutingPolicy } from "./policy"

export interface RouteDecision {
  /** provider-prefixed model for Bifrost's unified endpoint. */
  model: string
  fallbacks: string[]
  taskClass: string | null
  highRisk: boolean
}

const AGW_PREFIX = "agw:"

export const resolveRoute = (
  policy: RoutingPolicy | null,
  requestedModel: string,
): Result<RouteDecision, { code: string; message: string }> => {
  if (!requestedModel.startsWith(AGW_PREFIX)) {
    return ok({ model: requestedModel, fallbacks: [], taskClass: null, highRisk: false })
  }
  if (policy === null) {
    return err({ code: "no_routing_policy", message: "task-class routing requested but no routing policy is synced" })
  }
  const asked = requestedModel.slice(AGW_PREFIX.length)
  const taskClass = asked === "auto" ? policy.defaultClass : asked
  const cls = policy.classes[taskClass]
  if (cls === undefined) {
    return err({ code: "unknown_task_class", message: `task class "${taskClass}" is not in the routing policy` })
  }
  const [top, ...rest] = cls.ranked
  if (top === undefined) {
    return err({ code: "empty_task_class", message: `task class "${taskClass}" has no ranked routes` })
  }
  return ok({
    model: `${top.provider}/${top.model}`,
    fallbacks: rest.map((r) => `${r.provider}/${r.model}`),
    taskClass,
    highRisk: cls.highRisk === true,
  })
}
