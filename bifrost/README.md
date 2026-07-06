# Bifrost data plane

Bifrost (maximhq/bifrost) owns everything transport: provider abstraction, key
load-balancing, retries, request-level `fallbacks`, virtual-key failover chains,
streaming — at ~µs overhead. This directory is *configuration only*; adding a
provider is an edit to `data/config.json` (or `agw bifrost-config`), never code
in the control plane.

```bash
docker compose -f bifrost/docker-compose.yml up -d
curl -fsS localhost:8080/health
```

Notes that bite (verified against the v1.6.x docs):

- **JSON config only**, schema at <https://www.getbifrost.ai/schema>. We run
  `config_store.enabled: false` (pure GitOps): the file is the truth; UI/API
  edits are disabled from persisting. If you flip the store on, remember that
  DB edits then win over an unchanged `config.json`.
- **Model ids are provider-prefixed** on the unified endpoint:
  `POST /v1/chat/completions` with `"model": "openai/gpt-4o-mini"`.
- **Failover**: the gateway control plane sends the routing policy's ranking as
  the per-request `fallbacks` array. For client-independent failover, create a
  **virtual key** with multiple `provider_configs` (weights + allowed_models) —
  Bifrost auto-builds fallback chains for it.
- **Governance / virtual keys** (production): per-tenant VKs (`sk-bf-*`, with
  budgets + rate limits). Two ways, depending on how you run Bifrost:
  - **File-only mode (default here, `config_store.enabled: false`):** declare a
    `governance` block with virtual keys in `data/config.json` — the UI and
    `POST /api/governance/...` are read-only paths when the store is disabled,
    so the file is the source of truth.
  - **Store mode (`config_store.enabled: true`):** create VKs in the Bifrost
    UI or via `POST /api/governance/virtual-keys`; DB state then wins over
    `config.json`, so don't also declare them in the file.

  Either way, vault each VK into the gateway with
  `agw tenant set-upstream <tenant> --secret sk-bf-…` and set
  `AGW_REQUIRE_VK=true`.
- **Semantic cache**: built-in plugin, needs a vector store. Run the
  `semantic-cache` compose profile (Redis) and add to `data/config.json`:

  ```json
  {
    "vector_store": { "enabled": true, "type": "redis", "config": { "addr": "redis:6379" } },
    "plugins": [
      {
        "enabled": true,
        "name": "semantic_cache",
        "config": {
          "provider": "openai",
          "embedding_model": "text-embedding-3-small",
          "dimension": 1536,
          "ttl": "5m",
          "threshold": 0.8,
          "cache_by_model": true,
          "cache_by_provider": true
        }
      }
    ]
  }
  ```

  Caching only activates for requests carrying `x-bf-cache-key` — the gateway
  edge injects `tenant:<tenant-id>`, which is what makes the semantic cache
  tenant-scoped.
- **OTel**: Bifrost's own `otel` plugin can push data-plane traces to the same
  collector as the control plane (`trace_type: "genai_extension"`).
