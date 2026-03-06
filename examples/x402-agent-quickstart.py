"""
x402 Agent Quickstart — Python

Shows the three core operations every AI agent needs:
  1. Check agent status
  2. Execute a USDC payment (full x402 handshake handled automatically)
  3. Inspect the on-chain settlement result

Requirements:
  pip install algo-x402

Usage:
  ALGO_MNEMONIC="word1 word2 ... word25" \
  X402_AGENT_ID=my-agent-v1 \
  python examples/x402-agent-quickstart.py

Docs: https://ai-agentic-wallet.com/docs/api-reference.md
"""

from __future__ import annotations

import os
import sys

from algo_x402 import AlgoAgentClient, SettlementResult, VelocityBlock

# ── Config ─────────────────────────────────────────────────────

MNEMONIC   = os.environ.get("ALGO_MNEMONIC", "")
AGENT_ID   = os.environ.get("X402_AGENT_ID",  "my-python-agent-v1")
API_URL    = os.environ.get("X402_API_URL",   "https://api.ai-agentic-wallet.com")
PORTAL_KEY = os.environ.get("X402_PORTAL_KEY", "")

if not MNEMONIC:
    sys.exit("ALGO_MNEMONIC is required — set it to your 25-word Algorand mnemonic")

# ── Build client ────────────────────────────────────────────────

client = AlgoAgentClient(
    mnemonic   = MNEMONIC,
    agent_id   = AGENT_ID,
    base_url   = API_URL,
    portal_key = PORTAL_KEY,
)

print(f"\nAgent ID : {client.agent_id}")
print(f"Address  : {client.address}")

# ── 1. Check agent status ───────────────────────────────────────

print("\n── 1. AGENT STATUS ──────────────────────────────────────")
try:
    agent = client.get_agent()
    print(f"   status  : {agent.status}")
    print(f"   cohort  : {agent.cohort}")
    print(f"   auth    : {agent.auth_addr}")
    if agent.status in ("suspended", "orphaned"):
        sys.exit(f"Agent is {agent.status} — cannot sign transactions.")
except Exception as e:
    print(f"   (could not fetch status: {e})")

# ── 2. Execute a USDC payment ───────────────────────────────────
#
# The SDK handles the full x402 handshake automatically:
#   - Sends the request
#   - Absorbs the 402 challenge
#   - Builds and signs the Algorand toll payment
#   - Retries with the X-PAYMENT proof
#   - Forwards the sandbox export to /v1/api/execute
#   - Returns the on-chain settlement result

print("\n── 2. EXECUTE PAYMENT ───────────────────────────────────")

AMOUNT_USDC           = 0.01
DESTINATION_CHAIN     = "ethereum"
DESTINATION_RECIPIENT = "0xYourEthereumAddress"

print(f"   amount : ${AMOUNT_USDC:.4f} USDC → {DESTINATION_CHAIN}")

result = client.execute_trade(
    amount_usdc           = AMOUNT_USDC,
    destination_chain     = DESTINATION_CHAIN,
    destination_recipient = DESTINATION_RECIPIENT,
)

# ── 3. Inspect result ──────────────────────────────────────────

print("\n── 3. RESULT ────────────────────────────────────────────")

if isinstance(result, VelocityBlock):
    print("   STATUS : VELOCITY CAP HIT")
    print(f"   {result.message}")
    sys.exit(0)

if isinstance(result, SettlementResult):
    print("   STATUS : CONFIRMED")
    print(f"   txnId  : {result.txn_id}")
    print(f"   round  : {result.confirmed_round}")
    print(f"   at     : {result.settled_at}")
    print(f"   link   : {result.explorer_url}")
