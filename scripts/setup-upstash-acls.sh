#!/usr/bin/env bash
# setup-upstash-acls.sh — Print Upstash ACL configuration for each service database.
#
# Upstash enforces ACLs at the database level: each token is restricted to
# specific commands and key patterns. Even if application code is bypassed
# or a token is stolen, the database rejects out-of-scope operations at the
# Redis protocol level.
#
# ── What this script does ────────────────────────────────────────────────
# 1. Prints the exact ACL rules to configure in the Upstash console.
# 2. Optionally calls the Upstash REST Management API to create ACL tokens
#    automatically (requires UPSTASH_MANAGEMENT_TOKEN env var).
#
# ── Manual setup (no management token) ──────────────────────────────────
# Run without arguments to print setup instructions:
#   ./scripts/setup-upstash-acls.sh
#
# ── Automated setup (with management token) ─────────────────────────────
# Requires: UPSTASH_MANAGEMENT_TOKEN (from console.upstash.com → API Keys)
# Requires: SIGNER_DB_ID (the signing-service database ID from Upstash console)
#   UPSTASH_MANAGEMENT_TOKEN=xxx SIGNER_DB_ID=yyy ./scripts/setup-upstash-acls.sh --apply
#
# Usage:
#   ./scripts/setup-upstash-acls.sh           # print rules only
#   ./scripts/setup-upstash-acls.sh --apply   # create restricted tokens via API

set -euo pipefail

APPLY=false
for arg in "$@"; do
  case "$arg" in --apply) APPLY=true ;; esac
done

echo
echo "====================================================================="
echo " x402 Upstash ACL Configuration"
echo "====================================================================="
echo
echo "Two databases required for Module 7 isolation:"
echo "  DB-1: Main API database      (UPSTASH_REDIS_REST_URL)"
echo "  DB-2: Signing Service database (SIGNER_REDIS_REST_URL)"
echo

# ── Signing Service DB ACL ────────────────────────────────────────────────
echo "─────────────────────────────────────────────────────────────────────"
echo " SIGNING SERVICE DATABASE (SIGNER_REDIS_REST_URL)"
echo "─────────────────────────────────────────────────────────────────────"
echo
echo "In the Upstash console → Details → Access Control → Create Token:"
echo
echo "  Token name:      x402-signer-restricted"
echo "  Allowed commands: GET SET"
echo "  Key pattern:     x402:sign:*"
echo "  Denied commands: DEL KEYS FLUSHDB FLUSHALL SCAN (all mutations except SET)"
echo
echo "  Security rationale:"
echo "    - Signer can SET replay guard keys (x402:sign:replay:*, x402:sign:groupid:*)"
echo "    - Signer can GET to check if a key already exists (for idempotency)"
echo "    - Signer CANNOT delete rate-limit keys to bypass velocity limits"
echo "    - Signer CANNOT read agent records or auth tokens (different DB anyway)"
echo "    - Signer CANNOT flush the database or scan all keys"
echo
echo "  After creating: use this token as SIGNER_REDIS_REST_TOKEN in Railway."
echo

# ── Main API DB ACL ───────────────────────────────────────────────────────
echo "─────────────────────────────────────────────────────────────────────"
echo " MAIN API DATABASE (UPSTASH_REDIS_REST_URL)"
echo "─────────────────────────────────────────────────────────────────────"
echo
echo "The main API token retains full access to its own database."
echo "Isolation is achieved by keeping the signing service on a separate DB."
echo
echo "  Current token (UPSTASH_REDIS_REST_TOKEN): full access — no change needed."
echo
echo "  Future: per-agent tokens (AGENT_READ profile):"
echo "    Allowed commands: GET"
echo "    Key pattern:     x402:agents:{agentId}"
echo "    Rationale: each AI agent can only read its own registry record."
echo "               Cannot delete its own rate-limit keys to bypass limits."
echo "               Cannot modify another agent's auth-addr."
echo

# ── Automated ACL creation via Upstash Management API ─────────────────────
if [ "$APPLY" = false ]; then
  echo "─────────────────────────────────────────────────────────────────────"
  echo " To apply automatically: set UPSTASH_MANAGEMENT_TOKEN and SIGNER_DB_ID"
  echo " then rerun with --apply"
  echo "─────────────────────────────────────────────────────────────────────"
  echo
  echo "Done (printed rules only — no changes made)."
  exit 0
fi

# ── --apply: call Upstash Management API ──────────────────────────────────
MGMT_TOKEN="${UPSTASH_MANAGEMENT_TOKEN:-}"
SIGNER_DB_ID="${SIGNER_DB_ID:-}"

if [ -z "$MGMT_TOKEN" ]; then
  echo "ERROR: UPSTASH_MANAGEMENT_TOKEN is not set." >&2
  echo "Get it from: console.upstash.com → Account → API Keys" >&2
  exit 1
fi
if [ -z "$SIGNER_DB_ID" ]; then
  echo "ERROR: SIGNER_DB_ID is not set." >&2
  echo "Find it in: console.upstash.com → your signing-service database → Details" >&2
  exit 1
fi

echo "─────────────────────────────────────────────────────────────────────"
echo " Applying ACL via Upstash Management API..."
echo "─────────────────────────────────────────────────────────────────────"

# Create a restricted ACL token on the signing-service database
RESPONSE=$(curl -s -X POST \
  "https://api.upstash.com/v2/redis/database/${SIGNER_DB_ID}/credentials" \
  -H "Authorization: Bearer ${MGMT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "credential_name": "x402-signer-restricted",
    "allowlist_commands": ["get", "set"],
    "deny_list_commands": ["del", "keys", "flushdb", "flushall", "scan"],
    "key_whitelist": ["x402:sign:*"]
  }')

echo "Upstash API response:"
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
echo
echo "Copy the 'password' field above and use it as SIGNER_REDIS_REST_TOKEN"
echo "in your Railway signing-service environment variables."
echo
echo "Done."
