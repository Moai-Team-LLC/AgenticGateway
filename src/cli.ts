/**
 * `agw` CLI (FR-I.1): run/inspect the gateway, manage tenants/keys/vault,
 * sync routing policy from an AgenticPerformance eval export, and regenerate
 * the Bifrost provider config from the policy. Every mutation emits a
 * CliMutation evidence event (FR-I.2: mutations are authenticated by local
 * operator access and audited).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

import { Command } from "commander"

import { checkBudgets } from "./cost/budgets"
import { ensureTenantBudget } from "./cost/budgets"
import { unthrottleKey } from "./cost/anomaly"
import { makeEvidenceEmitter } from "./delegate/evidence"
import { loadConfig, type Config } from "./kernel/config"
import { openDb } from "./kernel/db"
import { loadPolicy, savePolicy } from "./routing/policy"
import { buildPolicyFromAplExport } from "./routing/sync"
import { startServer } from "./edge/server"
import { createTenant, findTenantByName, issueKey, revokeKey, setUpstreamSecret } from "./vault/vault"

const cfgOrDie = (): Config => {
  const cfg = loadConfig()
  if (cfg.isErr()) {
    console.error(cfg.error)
    process.exit(1)
  }
  return cfg.value
}

const audit = async (cfg: Config, tool: string, reason?: string): Promise<void> => {
  const evidence = makeEvidenceEmitter(cfg)
  evidence.emit({
    event: "CliMutation",
    session_id: null,
    tool,
    decision: "allow",
    ...(reason === undefined ? {} : { reason }),
  })
  await evidence.flush()
}

function die(message: string): never {
  console.error(message)
  process.exit(1)
}

const program = new Command()
program.name("agw").description("AgenticGateway control plane")

program
  .command("serve")
  .description("start the edge against a running Bifrost")
  .action(() => {
    const cfg = cfgOrDie()
    startServer(cfg)
  })

const tenant = program.command("tenant").description("tenant lifecycle")

tenant
  .command("create <name>")
  .description("create a tenant + first client key + budget (fail-closed default)")
  .option("--budget-usd <usd>", "windowed tenant budget in USD", "25")
  .option("--window-days <days>", "budget window length", "30")
  .action(async (name: string, opts: { budgetUsd: string; windowDays: string }) => {
    const cfg = cfgOrDie()
    const db = openDb(cfg.dbPath)
    const created = createTenant(db, name)
    if (created.isErr()) die(created.error)
    ensureTenantBudget(db, created.value.tenantId, {
      limitUsd: Number(opts.budgetUsd),
      windowMs: Number(opts.windowDays) * 24 * 60 * 60 * 1000,
    })
    await audit(cfg, "cli.tenant.create", name)
    console.log(`tenant:     ${name}`)
    console.log(`tenant id:  ${created.value.tenantId}`)
    console.log(`client key: ${created.value.clientKey}`)
    console.log("Store the client key now — only its hash is kept.")
  })

tenant
  .command("set-upstream <name>")
  .description("vault (or rotate) the tenant's upstream credential (Bifrost virtual key)")
  .requiredOption("--secret <secret>", "the upstream credential, e.g. sk-bf-…")
  .action(async (name: string, opts: { secret: string }) => {
    const cfg = cfgOrDie()
    if (cfg.vaultKey === undefined) die("AGW_VAULT_KEY is not set (openssl rand -hex 32)")
    const db = openDb(cfg.dbPath)
    const t = findTenantByName(db, name)
    if (t === null) die(`unknown tenant "${name}"`)
    const res = setUpstreamSecret(db, cfg.vaultKey as string, t.id, opts.secret)
    if (res.isErr()) die(res.error)
    await audit(cfg, "cli.tenant.set-upstream", name)
    console.log(res.value.rotated ? "rotated upstream credential" : "stored upstream credential")
  })

tenant
  .command("budget <name>")
  .description("set the tenant budget ceiling")
  .requiredOption("--budget-usd <usd>")
  .option("--window-days <days>", "budget window length", "30")
  .action(async (name: string, opts: { budgetUsd: string; windowDays: string }) => {
    const cfg = cfgOrDie()
    const db = openDb(cfg.dbPath)
    const t = findTenantByName(db, name)
    if (t === null) die(`unknown tenant "${name}"`)
    ensureTenantBudget(db, t.id, {
      limitUsd: Number(opts.budgetUsd),
      windowMs: Number(opts.windowDays) * 24 * 60 * 60 * 1000,
    })
    await audit(cfg, "cli.tenant.budget", name)
    console.log("budget updated")
  })

const key = program.command("key").description("client key lifecycle")

key
  .command("issue <tenantName>")
  .option("--label <label>")
  .action(async (tenantName: string, opts: { label?: string }) => {
    const cfg = cfgOrDie()
    const db = openDb(cfg.dbPath)
    const t = findTenantByName(db, tenantName)
    if (t === null) die(`unknown tenant "${tenantName}"`)
    const issued = issueKey(db, t.id, opts.label)
    if (issued.isErr()) die(issued.error)
    await audit(cfg, "cli.key.issue", tenantName)
    console.log(`key id:     ${issued.value.keyId}`)
    console.log(`client key: ${issued.value.clientKey}`)
  })

key.command("revoke <keyId>").action(async (keyId: string) => {
  const cfg = cfgOrDie()
  const db = openDb(cfg.dbPath)
  const res = revokeKey(db, keyId)
  if (res.isErr()) die(res.error)
  await audit(cfg, "cli.key.revoke", keyId)
  console.log("key revoked")
})

key.command("unthrottle <keyId>").action(async (keyId: string) => {
  const cfg = cfgOrDie()
  const db = openDb(cfg.dbPath)
  unthrottleKey(db, keyId)
  await audit(cfg, "cli.key.unthrottle", keyId)
  console.log("key unthrottled")
})

const routing = program.command("routing").description("routing policy (sourced from AgenticPerformance)")

routing
  .command("sync")
  .description("build + store the routing policy from an APL eval export (see docs/apl-eval-export.md)")
  .requiredOption("--from-file <path>", "APL eval export JSON")
  .option("--tenant <name>", "tenant-specific policy (default: the '*' policy)")
  .action(async (opts: { fromFile: string; tenant?: string }) => {
    const cfg = cfgOrDie()
    const db = openDb(cfg.dbPath)
    const raw: unknown = JSON.parse(readFileSync(opts.fromFile, "utf8"))
    const policy = buildPolicyFromAplExport(raw)
    if (policy.isErr()) die(policy.error)
    let tenantId = "*"
    if (opts.tenant !== undefined) {
      const t = findTenantByName(db, opts.tenant)
      if (t === null) die(`unknown tenant "${opts.tenant}"`)
      tenantId = t.id
    }
    const saved = savePolicy(db, policy.value, tenantId)
    if (saved.isErr()) die(saved.error)
    await audit(cfg, "cli.routing.sync", `eval-run ${policy.value.source.evalRunId ?? "?"}`)
    console.log(
      `routing policy stored (tenant ${tenantId}) from eval-run ${policy.value.source.evalRunId ?? "?"}: ` +
        `${Object.keys(policy.value.classes).join(", ")}`,
    )
  })

routing.command("show").option("--tenant <name>").action((opts: { tenant?: string }) => {
  const cfg = cfgOrDie()
  const db = openDb(cfg.dbPath)
  let tenantId = "*"
  if (opts.tenant !== undefined) {
    const t = findTenantByName(db, opts.tenant)
    if (t === null) die(`unknown tenant "${opts.tenant}"`)
    tenantId = t.id
  }
  const policy = loadPolicy(db, tenantId)
  if (policy.isErr()) die(policy.error)
  console.log(JSON.stringify(policy.value, null, 2))
})

program
  .command("bifrost-config")
  .description("regenerate bifrost/data/config.json providers from the routing policy")
  .option("--out <path>", "output path", "bifrost/data/config.json")
  .action(async (opts: { out: string }) => {
    const cfg = cfgOrDie()
    const db = openDb(cfg.dbPath)
    const policy = loadPolicy(db, "*")
    if (policy.isErr()) die(policy.error)
    const providers = new Set<string>(["openai", "anthropic"])
    if (policy.value !== null) {
      for (const cls of Object.values(policy.value.classes)) {
        for (const r of cls.ranked) providers.add(r.provider)
      }
    }
    const outPath = resolve(opts.out)
    const existing: Record<string, unknown> = existsSync(outPath)
      ? (JSON.parse(readFileSync(outPath, "utf8")) as Record<string, unknown>)
      : {}
    const providerBlock: Record<string, unknown> = {}
    for (const p of [...providers].toSorted()) {
      providerBlock[p] = (existing["providers"] as Record<string, unknown> | undefined)?.[p] ?? {
        keys: [
          {
            name: `${p}-key`,
            value: `env.${p.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
            models: ["*"],
            weight: 1.0,
          },
        ],
      }
    }
    const config = {
      ...existing,
      config_store: { enabled: false },
      providers: providerBlock,
    }
    writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`)
    await audit(cfg, "cli.bifrost-config", [...providers].toSorted().join(","))
    console.log(`wrote ${outPath} (providers: ${[...providers].toSorted().join(", ")})`)
  })

const inspect = program.command("inspect").description("read-only introspection")

inspect.command("ledger").option("--limit <n>", "rows", "20").action((opts: { limit: string }) => {
  const cfg = cfgOrDie()
  const db = openDb(cfg.dbPath)
  const rows = db
    .query("SELECT * FROM request_ledger ORDER BY created_at DESC LIMIT ?")
    .all(Math.min(Number(opts.limit) || 20, 500))
  console.log(JSON.stringify(rows, null, 2))
})

inspect.command("budgets").action(() => {
  const cfg = cfgOrDie()
  const db = openDb(cfg.dbPath)
  console.log(JSON.stringify(db.query("SELECT * FROM budgets").all(), null, 2))
})

inspect
  .command("check-budget <tenantName>")
  .description("dry-run the fail-closed budget gate for a tenant")
  .action((tenantName: string) => {
    const cfg = cfgOrDie()
    const db = openDb(cfg.dbPath)
    const t = findTenantByName(db, tenantName)
    if (t === null) die(`unknown tenant "${tenantName}"`)
    const res = checkBudgets(db, t.id, null, cfg.runLimitUsd)
    console.log(res.isOk() ? "allow" : `deny: ${res.error.scope} ${res.error.code}`)
  })

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
