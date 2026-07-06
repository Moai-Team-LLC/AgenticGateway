#!/usr/bin/env bash
# NFR-5: no re-implementation of sibling responsibilities, no direct provider
# transport. CI-enforced; do not defeat. Sibling logic may exist ONLY under
# vendor/ (verbatim, provenance-locked).
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# 1) Transport belongs to Bifrost: no provider SDKs in package.json.
if grep -Eq '"(openai|@anthropic-ai/(sdk|bedrock-sdk|vertex-sdk)|@google/generative-ai|@ai-sdk/[a-z-]+|cohere-ai|groq-sdk)"[[:space:]]*:' package.json; then
  echo "FAIL: provider SDK dependency in package.json — all provider I/O goes through Bifrost"
  fail=1
fi

# 2) The control plane never calls a provider host directly.
if grep -rEn 'api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|api\.mistral\.ai|openrouter\.ai' src scripts 2>/dev/null | grep -v no-reimpl-check; then
  echo "FAIL: direct provider host reference in the control plane"
  fail=1
fi

# 3) Guard logic lives in AgenticMind (vendored) — no second guard in src/.
if grep -rEn 'const[[:space:]]+(INJECTION_PATTERNS|PII_PATTERNS|LEAK_MARKERS)' src 2>/dev/null; then
  echo "FAIL: guard pattern definitions outside vendor/ — reuse AgenticMind's guard"
  fail=1
fi

# 4) Judge logic lives in AgenticPerformance (vendored) — no second judge.
if grep -rEn 'PASS_PATTERN|strict binary judge' src 2>/dev/null; then
  echo "FAIL: judge verdict logic outside vendor/ — delegate to AgenticPerformance"
  fail=1
fi

# 5) Protected-path policy lives in AgenticAssurance (vendored pack) — no
#    parallel path lists in src/.
if grep -rn '\.claude/settings\.json' src 2>/dev/null; then
  echo "FAIL: protected-path literals outside vendor/ — reuse the AgenticAssurance pack"
  fail=1
fi

# 6) Vendored files are provenance-locked and unmodified.
if ! bun run scripts/sync-vendor.ts --check > /dev/null; then
  echo "FAIL: vendored files drifted from vendor/PROVENANCE.lock.json"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "no-reimpl: clean"
