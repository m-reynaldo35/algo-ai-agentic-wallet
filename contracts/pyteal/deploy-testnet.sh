#!/usr/bin/env bash
# deploy-testnet.sh — Full MandateFactory + MandateContract testnet deploy
#
# Run ONCE per testnet deploy cycle. Steps:
#   1. Compile contracts (mandate_contract.py + mandate_factory.py)
#   2. Deploy MandateFactory — prints FACTORY_APP_ID
#   3. Upload compiled contract bytes to factory boxes — prints MANDATE_CONTRACT_APPROVAL_HASH
#   4. Create one test agent contract — prints MANDATE_APP_ID + app address
#
# Requirements:
#   OPERATOR_MNEMONIC  — set in .env or export before running
#   At least 2 ALGO on the operator testnet account:
#     https://bank.testnet.algorand.network/?account=<OPERATOR_ADDRESS>
#
# Usage:
#   export OPERATOR_MNEMONIC="your 25-word mnemonic here"
#   export AGENT_KEY="AGENT_ALGO_ADDRESS"         # your test agent's address
#   export MASTER_KEY="MASTER_WALLET_ADDRESS"     # operator address (same as operator for dev)
#   bash contracts/pyteal/deploy-testnet.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export ALGORAND_NETWORK="${ALGORAND_NETWORK:-testnet}"
export ALGOD_URL="${ALGOD_URL:-https://testnet-api.4160.nodely.dev}"
export ALGOD_TOKEN="${ALGOD_TOKEN:-}"
export X402_PAY_TO_ADDRESS="${X402_PAY_TO_ADDRESS:-C66AFZ3V5XN4ZHCXW6QQT4O6XDHMKSXITIWN4CRTMJUAKFCCH5QE4C2U74}"

if [ -z "${OPERATOR_MNEMONIC:-}" ]; then
  echo "ERROR: OPERATOR_MNEMONIC env var must be set"
  echo "  Fund this testnet address first: https://bank.testnet.algorand.network/"
  exit 1
fi

echo "=== Step 1: Compile contracts ==="
python3 mandate_contract.py
python3 mandate_factory.py
echo ""

echo "=== Step 2: Deploy MandateFactory ==="
FACTORY_OUTPUT=$(python3 deploy.py deploy-factory 2>&1)
echo "$FACTORY_OUTPUT"
FACTORY_APP_ID=$(echo "$FACTORY_OUTPUT" | grep "FACTORY_APP_ID=" | sed 's/.*FACTORY_APP_ID=//')
if [ -z "$FACTORY_APP_ID" ]; then
  echo "ERROR: Could not extract FACTORY_APP_ID from deploy output"
  exit 1
fi
export FACTORY_APP_ID="$FACTORY_APP_ID"
echo ""

echo "=== Step 3: Upload contract programs to factory ==="
PROGRAMS_OUTPUT=$(python3 deploy.py set-programs 2>&1)
echo "$PROGRAMS_OUTPUT"
APPROVAL_HASH=$(echo "$PROGRAMS_OUTPUT" | grep "MANDATE_CONTRACT_APPROVAL_HASH=" | sed 's/.*MANDATE_CONTRACT_APPROVAL_HASH=//')
echo ""

echo "=== Step 4: Create test agent contract ==="
AGENT_KEY="${AGENT_KEY:-}"
MASTER_KEY="${MASTER_KEY:-}"

if [ -z "$AGENT_KEY" ] || [ -z "$MASTER_KEY" ]; then
  echo "SKIP: Set AGENT_KEY and MASTER_KEY env vars to create a test agent"
else
  python3 deploy.py create-agent \
    --agent-key  "$AGENT_KEY"  \
    --master-key "$MASTER_KEY" \
    --max-per-tx 1000000       \
    --velocity   5000000       \
    --daily      50000000
fi
echo ""

echo "======================================================"
echo "  DEPLOY COMPLETE — set these Railway env vars:"
echo ""
echo "  MANDATE_FACTORY_APP_ID=$FACTORY_APP_ID"
echo "  MANDATE_CONTRACT_APPROVAL_HASH=$APPROVAL_HASH"
echo "  OPERATOR_MNEMONIC=<your mnemonic>"
echo "======================================================"
