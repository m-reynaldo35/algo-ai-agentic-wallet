"""
x402 Agent Quickstart — Python

Shows the three core operations every AI agent needs:
  1. Register agent (once per agent lifetime)
  2. Submit a USDC transaction
  3. Confirm the on-chain result

Requirements:
  pip install requests

Usage:
  X402_PORTAL_SECRET=<secret> \
  X402_AGENT_ID=my-agent-v1 \
  python examples/x402-agent-quickstart.py

Docs: https://ai-agentic-wallet.com/docs/api-reference.md
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from typing import Any

import requests

# ── Config ─────────────────────────────────────────────────────

BASE_URL      = os.getenv("X402_BASE_URL",      "https://ai-agentic-wallet.com")
PORTAL_SECRET = os.getenv("X402_PORTAL_SECRET", "")
AGENT_ID      = os.getenv("X402_AGENT_ID",      "my-python-agent-v1")

if not PORTAL_SECRET:
    sys.exit("X402_PORTAL_SECRET is required")

PORTAL_HEADERS = {
    "Content-Type":  "application/json",
    "Authorization": f"Bearer {PORTAL_SECRET}",
}

# ══════════════════════════════════════════════════════════════
# 1. REGISTER AGENT
# ══════════════════════════════════════════════════════════════


@dataclass
class RegisterResult:
    agent_id:             str
    address:              str
    cohort:               str
    auth_addr:            str
    registration_txn_id:  str
    explorer_url:         str


def register_agent(agent_id: str, platform: str = "python-sdk") -> RegisterResult:
    """
    Register a new agent on Algorand mainnet. Idempotent — returns
    the existing record if the agent is already registered.
    """
    res = requests.post(
        f"{BASE_URL}/api/agents/register",
        headers=PORTAL_HEADERS,
        json={"agentId": agent_id, "platform": platform},
        timeout=30,
    )

    if res.status_code == 409:
        print(f"[register] Agent '{agent_id}' already registered.")
        return get_agent_status(agent_id)  # type: ignore[return-value]

    if not res.ok:
        body = res.json()
        raise RuntimeError(f"Registration failed {res.status_code}: {body.get('error')}")

    data = res.json()
    return RegisterResult(
        agent_id            = data["agentId"],
        address             = data["address"],
        cohort              = data["cohort"],
        auth_addr           = data["authAddr"],
        registration_txn_id = data["registrationTxnId"],
        explorer_url        = data["explorerUrl"],
    )


# ══════════════════════════════════════════════════════════════
# 2. SUBMIT USDC TRANSACTION
# ══════════════════════════════════════════════════════════════
#
# The Python client calls /api/agent-action first (x402-gated).
# Unlike the TypeScript SDK, this demo does NOT handle the 402
# handshake automatically — it expects DISABLE_PORTAL_AUTH=true
# in dev or a pre-built X-PAYMENT proof in production.
#
# For a production Python agent, integrate the x402 handshake
# library or build the payment proof using py-algorand-sdk.


@dataclass
class SettlementResult:
    success:          bool
    agent_id:         str
    sandbox_id:       str
    confirmed:        bool
    confirmed_round:  int
    txn_id:           str
    group_id:         str
    txn_count:        int
    settled_at:       str


@dataclass
class VelocityBlock:
    ten_min_total:      int   # µUSDC
    day_total:          int   # µUSDC
    threshold_10m:      int   # µUSDC
    threshold_24h:      int   # µUSDC
    proposed_micro_usdc: int  # µUSDC


def _build_atomic_group(
    sender_address: str,
    amount_micro_usdc: int,
    destination_chain: str,
    destination_recipient: str,
    x_payment_header: str | None = None,
) -> dict[str, Any]:
    """
    Call /api/agent-action to build the sealed atomic group.
    Pass x_payment_header if you have a pre-built x402 proof.
    In dev (DISABLE_PORTAL_AUTH=true), omit it.
    """
    headers = dict(PORTAL_HEADERS)
    if x_payment_header:
        headers["X-PAYMENT"] = x_payment_header

    res = requests.post(
        f"{BASE_URL}/api/agent-action",
        headers=headers,
        json={
            "senderAddress":        sender_address,
            "amount":               amount_micro_usdc,
            "destinationChain":     destination_chain,
            "destinationRecipient": destination_recipient,
        },
        timeout=30,
    )

    if res.status_code == 402:
        # Server returned an x402 offer — need to build payment proof.
        # For production, implement the x402 handshake here using
        # py-algorand-sdk to sign the groupId and retry with X-PAYMENT.
        raise NotImplementedError(
            "x402 payment proof required. "
            "Implement the 402 handshake with py-algorand-sdk, "
            "or use DISABLE_PORTAL_AUTH=true in local dev."
        )

    if not res.ok:
        body = res.json()
        raise RuntimeError(f"agent-action failed {res.status_code}: {body.get('error')}")

    return res.json()["export"]


def submit_transaction(
    agent_id: str,
    sender_address: str,
    amount_micro_usdc: int,
    destination_chain: str,
    destination_recipient: str,
    max_retries: int = 3,
) -> SettlementResult | VelocityBlock:
    """
    Build and settle a USDC transaction through the x402 pipeline.
    Retries on transient 429/503 responses up to max_retries times.
    """
    print(f"[submit] Building atomic group for {amount_micro_usdc / 1e6:.6f} USDC...")

    sandbox_export = _build_atomic_group(
        sender_address        = sender_address,
        amount_micro_usdc     = amount_micro_usdc,
        destination_chain     = destination_chain,
        destination_recipient = destination_recipient,
    )

    print(f"[submit] Sandbox: {sandbox_export['sandboxId']}  Forwarding to /api/execute...")

    for attempt in range(1, max_retries + 1):
        res = requests.post(
            f"{BASE_URL}/api/execute",
            headers=PORTAL_HEADERS,
            json={"sandboxExport": sandbox_export, "agentId": agent_id},
            timeout=60,
        )

        if res.status_code == 200:
            data = res.json()
            s    = data["settlement"]
            return SettlementResult(
                success         = True,
                agent_id        = data["agentId"],
                sandbox_id      = data["sandboxId"],
                confirmed       = s["confirmed"],
                confirmed_round = s["confirmedRound"],
                txn_id          = s["txnId"],
                group_id        = s["groupId"],
                txn_count       = s["txnCount"],
                settled_at      = s["settledAt"],
            )

        if res.status_code == 402:
            data = res.json()
            return VelocityBlock(
                ten_min_total       = int(data["tenMinTotal"]),
                day_total           = int(data["dayTotal"]),
                threshold_10m       = int(data["threshold10m"]),
                threshold_24h       = int(data["threshold24h"]),
                proposed_micro_usdc = int(data["proposedMicroUsdc"]),
            )

        if res.status_code in (429, 503):
            retry_after = int(res.headers.get("Retry-After", "60"))
            err         = res.json().get("error", "unknown")

            if attempt < max_retries:
                print(f"[submit] {err} — retrying in {retry_after}s (attempt {attempt}/{max_retries})")
                time.sleep(retry_after)
                continue

            raise RuntimeError(f"{err}: rate limited after {max_retries} attempts")

        body = res.json()
        raise RuntimeError(f"Execute failed {res.status_code}: {body.get('error')}")

    raise RuntimeError("Max retries exceeded")


# ══════════════════════════════════════════════════════════════
# 3. CHECK AGENT STATUS
# ══════════════════════════════════════════════════════════════


@dataclass
class AgentStatus:
    agent_id:           str
    address:            str
    status:             str   # registered | active | suspended | orphaned
    cohort:             str
    auth_addr:          str
    custody:            str
    custody_version:    int
    created_at:         str
    registration_txn_id: str


def get_agent_status(agent_id: str) -> AgentStatus:
    from urllib.parse import quote
    res = requests.get(
        f"{BASE_URL}/api/agents/{quote(agent_id, safe='')}",
        headers=PORTAL_HEADERS,
        timeout=15,
    )

    if res.status_code == 404:
        raise RuntimeError(f"Agent not found: {agent_id}")
    if not res.ok:
        raise RuntimeError(f"Status check failed: {res.status_code}")

    d = res.json()
    return AgentStatus(
        agent_id            = d["agentId"],
        address             = d["address"],
        status              = d["status"],
        cohort              = d["cohort"],
        auth_addr           = d["authAddr"],
        custody             = d.get("custody", "rocca"),
        custody_version     = d.get("custodyVersion", 0),
        created_at          = d["createdAt"],
        registration_txn_id = d.get("registrationTxnId", ""),
    )


# ══════════════════════════════════════════════════════════════
# MAIN — end-to-end demo
# ══════════════════════════════════════════════════════════════


def main() -> None:
    # 1. Register (idempotent)
    print("\n── 1. REGISTER AGENT ────────────────────────────────")
    reg = register_agent(AGENT_ID)
    print(f"   agentId: {reg.agent_id}")
    print(f"   address: {reg.address}")

    # 2. Check status
    print("\n── 2. CHECK STATUS ──────────────────────────────────")
    status = get_agent_status(AGENT_ID)
    print(f"   status:  {status.status}")
    print(f"   cohort:  {status.cohort}")

    if status.status in ("suspended", "orphaned"):
        sys.exit(f"Agent is {status.status} — cannot sign transactions.")

    # Fund reminder (off-chain step)
    print(f"\n   ⚡ Fund '{status.address}' with USDC on Algorand mainnet")
    print("      before submitting transactions.\n")

    # 3. Submit USDC transaction
    print("── 3. SUBMIT TRANSACTION ────────────────────────────")
    AMOUNT_USDC = 1.0

    result = submit_transaction(
        agent_id              = AGENT_ID,
        sender_address        = status.address,
        amount_micro_usdc     = round(AMOUNT_USDC * 1_000_000),
        destination_chain     = "ethereum",
        destination_recipient = "0xYourEthereumAddress",
    )

    # 4. Confirm on-chain result
    print("\n── 4. RESULT ────────────────────────────────────────")

    if isinstance(result, VelocityBlock):
        spent_10m = result.ten_min_total  / 1e6
        spent_24h = result.day_total      / 1e6
        cap_10m   = result.threshold_10m  / 1e6
        cap_24h   = result.threshold_24h  / 1e6
        print("   STATUS: VELOCITY BLOCK")
        print(f"   10-min window: ${spent_10m:.2f} / ${cap_10m:.2f} USDC")
        print(f"   24-hour window: ${spent_24h:.2f} / ${cap_24h:.2f} USDC")
        print("   Action: wait for window reset, or request an approval token.")
        return

    if result.success:
        print("   STATUS: CONFIRMED")
        print(f"   txnId:  {result.txn_id}")
        print(f"   round:  {result.confirmed_round}")
        print(f"   at:     {result.settled_at}")
        print(f"   https://allo.info/tx/{result.txn_id}")


if __name__ == "__main__":
    main()
