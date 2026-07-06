/**
 * Environment config — zod on the boundary, fail-closed. Anything invalid or
 * inconsistent (e.g. http evidence sink without a URL) refuses to start rather
 * than degrading silently.
 */

import { err, ok, type Result } from "neverthrow"
import { z } from "zod"

const boolish = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true")

const envSchema = z
  .object({
    AGW_PORT: z.coerce.number().int().positive().default(8787),
    AGW_DB_PATH: z.string().default("./data/agw.db"),
    BIFROST_URL: z.string().url().default("http://localhost:8080"),
    /** Vault master key (32 bytes hex). Optional at boot; required by vault ops. */
    AGW_VAULT_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, "AGW_VAULT_KEY must be 64 hex chars (openssl rand -hex 32)")
      .optional(),
    /** Read-only admin bearer. Unset = /admin disabled (fail-closed). */
    AGW_ADMIN_TOKEN: z.string().min(16, "AGW_ADMIN_TOKEN must be ≥16 chars").optional(),
    AGW_REQUIRE_VK: boolish,
    AGW_RUN_LIMIT_USD: z.coerce.number().positive().default(5),
    AGW_GUARD_MAX_CHARS: z.coerce.number().int().positive().default(512_000),
    AGW_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300_000),
    AGW_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(1024),
    AGW_EVIDENCE_SINK: z.enum(["file", "http", "off"]).default("file"),
    AGW_EVIDENCE_FILE: z.string().default("./data/evidence.jsonl"),
    AGW_AUDIT_URL: z.string().url().optional(),
    AGW_AUDIT_TOKEN: z.string().optional(),
    AGW_JUDGE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.05),
    AGW_JUDGE_MODEL: z.string().default("openai/gpt-4o-mini"),
    AGW_PROTECTED_PATH_MODE: z.enum(["report", "block"]).default("report"),
    AGW_ANOMALY_FACTOR: z.coerce.number().min(1).default(5),
    AGW_ANOMALY_THROTTLE: boolish,
    APL_INGEST_URL: z.string().url().optional(),
    APL_INGEST_TOKEN: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.AGW_EVIDENCE_SINK === "http" && cfg.AGW_AUDIT_URL === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "AGW_EVIDENCE_SINK=http requires AGW_AUDIT_URL",
        path: ["AGW_AUDIT_URL"],
      })
    }
  })

export interface Config {
  port: number
  dbPath: string
  bifrostUrl: string
  vaultKey: string | undefined
  adminToken: string | undefined
  requireVk: boolean
  runLimitUsd: number
  guardMaxChars: number
  cacheTtlMs: number
  cacheMaxEntries: number
  evidenceSink: "file" | "http" | "off"
  evidenceFile: string
  auditUrl: string | undefined
  auditToken: string | undefined
  judgeSampleRate: number
  judgeModel: string
  protectedPathMode: "report" | "block"
  anomalyFactor: number
  anomalyThrottle: boolean
  aplIngestUrl: string | undefined
  aplIngestToken: string | undefined
}

export const loadConfig = (env: Record<string, string | undefined> = process.env): Result<Config, string> => {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return err(`invalid config: ${issues}`)
  }
  const e = parsed.data
  return ok({
    port: e.AGW_PORT,
    dbPath: e.AGW_DB_PATH,
    bifrostUrl: e.BIFROST_URL.replace(/\/$/, ""),
    vaultKey: e.AGW_VAULT_KEY,
    adminToken: e.AGW_ADMIN_TOKEN,
    requireVk: e.AGW_REQUIRE_VK,
    runLimitUsd: e.AGW_RUN_LIMIT_USD,
    guardMaxChars: e.AGW_GUARD_MAX_CHARS,
    cacheTtlMs: e.AGW_CACHE_TTL_MS,
    cacheMaxEntries: e.AGW_CACHE_MAX_ENTRIES,
    evidenceSink: e.AGW_EVIDENCE_SINK,
    evidenceFile: e.AGW_EVIDENCE_FILE,
    auditUrl: e.AGW_AUDIT_URL,
    auditToken: e.AGW_AUDIT_TOKEN,
    judgeSampleRate: e.AGW_JUDGE_SAMPLE_RATE,
    judgeModel: e.AGW_JUDGE_MODEL,
    protectedPathMode: e.AGW_PROTECTED_PATH_MODE,
    anomalyFactor: e.AGW_ANOMALY_FACTOR,
    anomalyThrottle: e.AGW_ANOMALY_THROTTLE,
    aplIngestUrl: e.APL_INGEST_URL,
    aplIngestToken: e.APL_INGEST_TOKEN,
  })
}
