#!/usr/bin/env bash
# x402 Agent Quickstart — curl
#
# Shows the three core operations every AI agent needs:
#   1. Register agent (once per agent lifetime)
#   2. Submit a USDC transaction
#   3. Confirm the on-chain result
#
# Usage:
#   export X402_PORTAL_SECRET=<your-portal-secret>
#   export X402_AGENT_ID=my-agent-v1           # optional, defaults below
#   export X402_BASE_URL=https://ai-agentic-wallet.com
#   bash examples/x402-agent-quickstart.sh

set -euo pipefail

BASE_URL="${X402_BASE_URL:-https://ai-agentic-wallet.com}"
AGENT_ID="${X402_AGENT_ID:-my-curl-agent-v1}"

if [ -z "${X402_PORTAL_SECRET:-}" ]; then
  echo "ERROR: X402_PORTAL_SECRET is required" >&2
  exit 1
fi

AUTH_HEADER="Authorization: Bearer ${X402_PORTAL_SECRET}"
CT_HEADER="Content-Type: application/json"

echo
echo "══════════════════════════════════════════════════════════════"
echo "  x402 Agent Quickstart"
echo "  Base URL: ${BASE_URL}"
echo "  Agent ID: ${AGENT_ID}"
echo "══════════════════════════════════════════════════════════════"


# ══════════════════════════════════════════════════════════════
# 1. REGISTER AGENT
# ══════════════════════════════════════════════════════════════
# POST /api/agents/register
#
# Creates an Algorand wallet, opts it into USDC (ASA 31566704),
# and rekeys it to the Rocca signer in one atomic group.
# Returns 409 if agentId is already registered (not an error).

echo
echo "── 1. REGISTER AGENT ────────────────────────────────────"
echo "   POST /api/agents/register"
echo

REGISTER_RESPONSE=$(curl --silent --show-error \
  --request POST \
  --url     "${BASE_URL}/api/agents/register" \
  --header  "${AUTH_HEADER}" \
  --header  "${CT_HEADER}" \
  --data    "{\"agentId\": \"${AGENT_ID}\", \"platform\": \"curl\"}" \
  --write-out "\n%{http_code}" \
)

HTTP_CODE=$(echo "${REGISTER_RESPONSE}" | tail -n1)
REGISTER_BODY=$(echo "${REGISTER_RESPONSE}" | head -n-1)

if [ "${HTTP_CODE}" = "409" ]; then
  echo "   → Agent already registered (409) — continuing."
elif [ "${HTTP_CODE}" = "201" ]; then
  echo "   → Registered (201)"
  echo "${REGISTER_BODY}" | python3 -m json.tool 2>/dev/null || echo "${REGISTER_BODY}"
  AGENT_ADDRESS=$(echo "${REGISTER_BODY}" | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])" 2>/dev/null || echo "")
  EXPLORER_URL=$(echo "${REGISTER_BODY}"  | python3 -c "import sys,json; print(json.load(sys.stdin)['explorerUrl'])" 2>/dev/null || echo "")
  echo
  echo "   ⚡ Fund this address with USDC on Algorand mainnet:"
  echo "      ${AGENT_ADDRESS}"
  echo "      ${EXPLORER_URL}"
else
  echo "   ERROR: HTTP ${HTTP_CODE}"
  echo "${REGISTER_BODY}"
  exit 1
fi


# ══════════════════════════════════════════════════════════════
# 2. CHECK AGENT STATUS
# ══════════════════════════════════════════════════════════════
# GET /api/agents/:agentId
#
# Returns: address, status (active|registered|suspended|orphaned),
#          cohort, authAddr, custody, custodyVersion.

echo
echo "── 2. CHECK STATUS ──────────────────────────────────────"
echo "   GET /api/agents/${AGENT_ID}"
echo

STATUS_RESPONSE=$(curl --silent --show-error \
  --request GET \
  --url     "${BASE_URL}/api/agents/${AGENT_ID}" \
  --header  "${AUTH_HEADER}" \
)

echo "${STATUS_RESPONSE}" | python3 -m json.tool 2>/dev/null || echo "${STATUS_RESPONSE}"

AGENT_STATUS=$(echo "${STATUS_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "unknown")
AGENT_ADDRESS=$(echo "${STATUS_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])" 2>/dev/null || echo "")

if [ "${AGENT_STATUS}" = "suspended" ] || [ "${AGENT_STATUS}" = "orphaned" ]; then
  echo "   ERROR: Agent is ${AGENT_STATUS} — cannot sign transactions." >&2
  exit 1
fi


# ══════════════════════════════════════════════════════════════
# 3. SUBMIT TRANSACTION — STEP A: Build atomic group
# ══════════════════════════════════════════════════════════════
# POST /api/agent-action
#
# NOTE: This endpoint is normally x402-gated (returns 402 on first
# call). In development with DISABLE_PORTAL_AUTH=true the portal
# secret bypasses the x402 check. In production, build an X-PAYMENT
# proof using py-algorand-sdk or @m-reynaldo35/x402-client.

echo
echo "── 3a. BUILD ATOMIC GROUP ───────────────────────────────"
echo "   POST /api/agent-action"
echo "   NOTE: Requires X-PAYMENT header in production."
echo

AMOUNT_MICRO_USDC=1000000   # 1.00 USDC
DEST_CHAIN="ethereum"
DEST_ADDRESS="0xYourEthereumAddress"

ACTION_RESPONSE=$(curl --silent --show-error \
  --request POST \
  --url     "${BASE_URL}/api/agent-action" \
  --header  "${AUTH_HEADER}" \
  --header  "${CT_HEADER}" \
  --data    "{
    \"senderAddress\":        \"${AGENT_ADDRESS}\",
    \"amount\":               ${AMOUNT_MICRO_USDC},
    \"destinationChain\":     \"${DEST_CHAIN}\",
    \"destinationRecipient\": \"${DEST_ADDRESS}\"
  }" \
  --write-out "\n%{http_code}" \
)

ACTION_CODE=$(echo "${ACTION_RESPONSE}" | tail -n1)
ACTION_BODY=$(echo "${ACTION_RESPONSE}" | head -n-1)

if [ "${ACTION_CODE}" = "402" ]; then
  echo "   → HTTP 402: x402 payment proof required."
  echo "   Use the TypeScript SDK (AlgoAgentClient) or build X-PAYMENT"
  echo "   manually with py-algorand-sdk to proceed in production."
  echo "${ACTION_BODY}" | python3 -m json.tool 2>/dev/null || echo "${ACTION_BODY}"
  exit 0
fi

if [ "${ACTION_CODE}" != "200" ]; then
  echo "   ERROR: HTTP ${ACTION_CODE}"
  echo "${ACTION_BODY}"
  exit 1
fi

echo "   → Sandbox sealed (200)"
SANDBOX_ID=$(echo "${ACTION_BODY}" | python3 -c "import sys,json; print(json.load(sys.stdin)['export']['sandboxId'])" 2>/dev/null || echo "")
echo "   sandboxId: ${SANDBOX_ID}"

# Extract full sandboxExport for execute call
SANDBOX_EXPORT=$(echo "${ACTION_BODY}" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['export']))" 2>/dev/null)


# ══════════════════════════════════════════════════════════════
# 3. SUBMIT TRANSACTION — STEP B: Execute settlement
# ══════════════════════════════════════════════════════════════
# POST /api/execute
#
# Runs: validate → sign (Rocca) → broadcast → confirm.
# Idempotent on sandboxId (safe to retry on network timeout).

echo
echo "── 3b. EXECUTE SETTLEMENT ───────────────────────────────"
echo "   POST /api/execute"
echo

EXECUTE_RESPONSE=$(curl --silent --show-error \
  --request POST \
  --url     "${BASE_URL}/api/execute" \
  --header  "${AUTH_HEADER}" \
  --header  "${CT_HEADER}" \
  --data    "{\"sandboxExport\": ${SANDBOX_EXPORT}, \"agentId\": \"${AGENT_ID}\"}" \
  --write-out "\n%{http_code}" \
)

EXEC_CODE=$(echo "${EXECUTE_RESPONSE}" | tail -n1)
EXEC_BODY=$(echo "${EXECUTE_RESPONSE}" | head -n-1)


# ══════════════════════════════════════════════════════════════
# 4. CONFIRM ON-CHAIN RESULT
# ══════════════════════════════════════════════════════════════

echo
echo "── 4. RESULT ────────────────────────────────────────────"
echo "   HTTP ${EXEC_CODE}"
echo

case "${EXEC_CODE}" in
  200)
    echo "   STATUS: CONFIRMED"
    echo "${EXEC_BODY}" | python3 -m json.tool 2>/dev/null || echo "${EXEC_BODY}"
    TXN_ID=$(echo "${EXEC_BODY}" | python3 -c "import sys,json; print(json.load(sys.stdin)['settlement']['txnId'])" 2>/dev/null || echo "")
    if [ -n "${TXN_ID}" ]; then
      echo
      echo "   https://allo.info/tx/${TXN_ID}"
    fi
    ;;
  402)
    echo "   STATUS: VELOCITY BLOCK"
    echo "${EXEC_BODY}" | python3 -m json.tool 2>/dev/null || echo "${EXEC_BODY}"
    echo
    echo "   Action: wait for the 10-minute window to reset, or request"
    echo "   an approval token via POST /api/agents/${AGENT_ID}/approval-token"
    ;;
  429|503)
    RETRY_AFTER=$(echo "${EXECUTE_RESPONSE}" | grep -i "retry-after" | awk '{print $2}' || echo "60")
    echo "${EXEC_BODY}" | python3 -m json.tool 2>/dev/null || echo "${EXEC_BODY}"
    echo
    echo "   Action: retry after ${RETRY_AFTER}s"
    ;;
  *)
    echo "   ERROR:"
    echo "${EXEC_BODY}" | python3 -m json.tool 2>/dev/null || echo "${EXEC_BODY}"
    exit 1
    ;;
esac

echo
echo "══════════════════════════════════════════════════════════════"
echo "  Done."
echo "══════════════════════════════════════════════════════════════"
