"""
AlgoAgentClient — high-level x402 client for Python agents.

Usage:
    from algo_x402 import AlgoAgentClient

    client = AlgoAgentClient(
        mnemonic  = "word1 word2 ... word25",
        agent_id  = "my-agent-001",
        base_url  = "https://api.ai-agentic-wallet.com",
    )

    # Single trade
    result = client.execute_trade(
        amount_usdc           = 1.0,
        destination_chain     = "ethereum",
        destination_recipient = "0xYourAddress",
    )

    # Batched trades (up to 16 — Algorand atomic group limit)
    result = client.execute_batch([
        {"destinationChain": "ethereum", "destinationRecipient": "0xA...", "amount": 500000},
        {"destinationChain": "solana",   "destinationRecipient": "Abc...", "amount": 500000},
    ])
"""
from __future__ import annotations

import time
from typing import Any
from urllib.parse import quote

import algosdk.mnemonic
import algosdk.account
import requests

from ._interceptor import request_with_payment
from .types import (
    AgentInfo,
    DestinationChain,
    SettlementResult,
    TradeResult,
    VelocityBlock,
    X402Error,
    X402ErrorCode,
)

_DEFAULT_BASE_URL = "https://api.ai-agentic-wallet.com"
_DEFAULT_NODE_URL = "https://mainnet-api.4160.nodely.dev"
_DEFAULT_SLIPPAGE = 50  # basis points


class AlgoAgentClient:
    """
    x402 client for Python AI agents.

    Encapsulates the full x402 handshake:
      402 bounce → proof generation → sandbox export → settlement
    """

    def __init__(
        self,
        mnemonic:       str,
        agent_id:       str,
        base_url:       str  = _DEFAULT_BASE_URL,
        portal_key:     str  = "",
        slippage_bips:  int  = _DEFAULT_SLIPPAGE,
        node_url:       str  = _DEFAULT_NODE_URL,
        max_retries:    int  = 2,
        timeout:        int  = 30,
    ) -> None:
        """
        Args:
            mnemonic:      25-word Algorand mnemonic of your registered agent wallet.
            agent_id:      Agent ID registered with the wallet router.
            base_url:      Wallet router base URL.
            portal_key:    X-Portal-Key header value (if required by your server).
            slippage_bips: Slippage tolerance in basis points (default 50 = 0.5%).
            node_url:      Algorand algod URL for suggested params during proof building.
            max_retries:   Transient failure retry count.
            timeout:       HTTP request timeout in seconds.
        """
        if not mnemonic:
            raise X402Error("mnemonic is required", X402ErrorCode.CONFIG_ERROR)
        if not agent_id:
            raise X402Error("agent_id is required", X402ErrorCode.CONFIG_ERROR)

        self._private_key  = algosdk.mnemonic.to_private_key(mnemonic)
        self.address       = algosdk.account.address_from_private_key(self._private_key)
        self.agent_id      = agent_id
        self._base_url     = base_url.rstrip("/")
        self._portal_key   = portal_key
        self._slippage     = slippage_bips
        self._node_url     = node_url
        self._max_retries  = max_retries
        self._timeout      = timeout

    # ── Public API ────────────────────────────────────────────────

    def execute_trade(
        self,
        amount_usdc:           float | None = None,
        destination_chain:     str | DestinationChain | None = None,
        destination_recipient: str | None = None,
    ) -> TradeResult:
        """
        Execute a full x402 trade: 402 handshake → sandbox export → settlement.

        Args:
            amount_usdc:           Trade amount in USDC (e.g. 0.01). Omit for server default.
            destination_chain:     Destination chain for USDC bridging.
            destination_recipient: Recipient address on the destination chain.

        Returns:
            SettlementResult on success, VelocityBlock if the velocity cap was hit.

        Raises:
            X402Error: on protocol or network failures.
        """
        body: dict[str, Any] = {"senderAddress": self.address}
        if amount_usdc is not None:
            body["amount"] = round(amount_usdc * 1_000_000)
        if destination_chain:
            body["destinationChain"] = str(destination_chain)
        if destination_recipient:
            body["destinationRecipient"] = destination_recipient

        headers = self._base_headers()
        headers["X-SLIPPAGE-BIPS"] = str(self._slippage)

        resp = request_with_payment(
            url         = f"{self._base_url}/v1/api/agent-action",
            method      = "POST",
            headers     = headers,
            body        = body,
            private_key = self._private_key,
            sender_addr = self.address,
            node_url    = self._node_url,
            max_retries = self._max_retries,
            timeout     = self._timeout,
        )

        if not resp.ok:
            data = resp.json()
            raise X402Error(
                f"agent-action failed ({resp.status_code}): {data.get('error', resp.reason)}",
                X402ErrorCode.SANDBOX_ERROR,
            )

        sandbox_export = resp.json()["export"]
        return self._settle(sandbox_export)

    def execute_batch(
        self,
        intents: list[dict[str, Any]],
    ) -> TradeResult:
        """
        Execute multiple trades as a single atomic group (max 16).

        Args:
            intents: List of trade intent dicts. Each may contain:
                     amount (µUSDC), destinationChain, destinationRecipient, slippageBips.

        Returns:
            SettlementResult on success, VelocityBlock if velocity cap hit.
        """
        if not intents:
            raise X402Error("intents list cannot be empty", X402ErrorCode.CONFIG_ERROR)
        if len(intents) > 16:
            raise X402Error(
                f"Batch size {len(intents)} exceeds Algorand atomic group limit of 16",
                X402ErrorCode.CONFIG_ERROR,
            )

        body: dict[str, Any] = {"senderAddress": self.address, "intents": intents}
        headers = self._base_headers()
        headers["X-SLIPPAGE-BIPS"] = str(self._slippage)

        resp = request_with_payment(
            url         = f"{self._base_url}/v1/api/batch-action",
            method      = "POST",
            headers     = headers,
            body        = body,
            private_key = self._private_key,
            sender_addr = self.address,
            node_url    = self._node_url,
            max_retries = self._max_retries,
            timeout     = self._timeout,
        )

        if not resp.ok:
            data = resp.json()
            raise X402Error(
                f"batch-action failed ({resp.status_code}): {data.get('error', resp.reason)}",
                X402ErrorCode.SANDBOX_ERROR,
            )

        sandbox_export = resp.json()["export"]
        return self._settle(sandbox_export)

    def get_agent(self, agent_id: str | None = None) -> AgentInfo:
        """Fetch the current registry record for an agent (defaults to this client's agent_id)."""
        target = agent_id or self.agent_id
        resp = requests.get(
            f"{self._base_url}/v1/api/agents/{quote(target, safe='')}",
            headers=self._base_headers(),
            timeout=self._timeout,
        )
        if resp.status_code == 404:
            raise X402Error(f"Agent not found: {target}", X402ErrorCode.UNKNOWN)
        resp.raise_for_status()
        d = resp.json()
        return AgentInfo(
            agent_id            = d["agentId"],
            address             = d["address"],
            status              = d["status"],
            cohort              = d["cohort"],
            auth_addr           = d["authAddr"],
            custody             = d.get("custody", "rocca"),
            custody_version     = d.get("custodyVersion", 0),
            created_at          = d["createdAt"],
            registration_txn_id = d.get("registrationTxnId"),
        )

    def poll_job(
        self,
        job_id:       str,
        poll_interval: float = 2.0,
        timeout:       float = 120.0,
    ) -> SettlementResult:
        """
        Poll an async job until confirmed or timed out.

        Args:
            job_id:        Job ID returned by a queued execute response.
            poll_interval: Seconds between polls (default 2).
            timeout:       Total polling timeout in seconds (default 120).

        Returns:
            SettlementResult once the job is confirmed.

        Raises:
            X402Error: if the job fails or polling times out.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            resp = requests.get(
                f"{self._base_url}/v1/api/jobs/{quote(job_id, safe='')}",
                headers=self._base_headers(),
                timeout=self._timeout,
            )
            resp.raise_for_status()
            data = resp.json()

            status = data.get("status")
            if status == "confirmed":
                s = data["settlement"]
                return SettlementResult(
                    success         = True,
                    agent_id        = data.get("agentId", self.agent_id),
                    sandbox_id      = data.get("sandboxId", ""),
                    txn_id          = s["txnId"],
                    confirmed_round = s["confirmedRound"],
                    group_id        = s["groupId"],
                    txn_count       = s.get("txnCount", 1),
                    settled_at      = s["settledAt"],
                )
            if status == "failed":
                raise X402Error(
                    f"Job {job_id} failed: {data.get('error', 'unknown')}",
                    X402ErrorCode.SETTLEMENT_ERROR,
                )

            time.sleep(poll_interval)

        raise X402Error(f"Job {job_id} did not confirm within {timeout}s", X402ErrorCode.UNKNOWN)

    # ── Internal ─────────────────────────────────────────────────

    def _settle(self, sandbox_export: dict[str, Any]) -> TradeResult:
        headers = self._base_headers()
        resp = requests.post(
            f"{self._base_url}/v1/api/execute",
            headers = headers,
            json    = {"sandboxExport": sandbox_export, "agentId": self.agent_id},
            timeout = self._timeout,
        )

        # Velocity cap — server returns 402 VELOCITY_APPROVAL_REQUIRED
        if resp.status_code == 402:
            data = resp.json()
            return VelocityBlock(
                ten_min_total       = int(data.get("tenMinTotal", 0)),
                day_total           = int(data.get("dayTotal", 0)),
                threshold_10m       = int(data.get("threshold10m", 0)),
                threshold_24h       = int(data.get("threshold24h", 0)),
                proposed_micro_usdc = int(data.get("proposedMicroUsdc", 0)),
            )

        # Queued async job
        if resp.status_code == 200:
            data = resp.json()
            if data.get("queued"):
                job_id = data.get("jobId", "")
                return self.poll_job(job_id)

        if not resp.ok:
            data = resp.json()
            is_policy = "POLICY_BREACH" in str(data.get("error", ""))
            raise X402Error(
                f"Settlement failed ({resp.status_code}): {data.get('error', resp.reason)}",
                X402ErrorCode.POLICY_BREACH if is_policy else X402ErrorCode.SETTLEMENT_ERROR,
            )

        data = resp.json()
        if not data.get("success"):
            raise X402Error(
                f"Settlement pipeline failed at stage '{data.get('failedStage', '?')}': {data.get('error', '')}",
                X402ErrorCode.SETTLEMENT_ERROR,
            )

        s = data["settlement"]
        return SettlementResult(
            success         = True,
            agent_id        = data["agentId"],
            sandbox_id      = data["sandboxId"],
            txn_id          = s["txnId"],
            confirmed_round = s["confirmedRound"],
            group_id        = s["groupId"],
            txn_count       = s.get("txnCount", 1),
            settled_at      = s["settledAt"],
        )

    def _base_headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Content-Type": "application/json"}
        if self._portal_key:
            h["X-Portal-Key"] = self._portal_key
        return h
