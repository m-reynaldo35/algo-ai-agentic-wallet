"""
x402 Payment Interceptor

Handles the full 402 handshake:
  1. Send the original request
  2. On 402: parse pay+json terms
  3. Build Algorand toll transaction and sign it
  4. Construct X-PAYMENT proof header
  5. Retry the original request with the proof

The caller sees only the final 200 response.
"""
from __future__ import annotations

import base64
import json
import time
import uuid
from typing import Any

import algosdk
import algosdk.transaction
import algosdk.encoding
import algosdk.util
import requests

from .types import X402Error, X402ErrorCode

# Default Nodely mainnet algod URL — overridable via AlgoAgentClient
_DEFAULT_NODE_URL = "https://mainnet-api.4160.nodely.dev"


def _build_proof(
    pay_json:     dict[str, Any],
    private_key:  str,   # base64-encoded 32-byte ed25519 signing key (algosdk format)
    sender_addr:  str,
    node_url:     str = _DEFAULT_NODE_URL,
) -> str:
    """Build a base64-encoded X-PAYMENT proof for the given pay+json offer."""
    algod = algosdk.algod.AlgodClient("", node_url)
    params = algod.suggested_params()

    asset_id = int(pay_json["payment"]["asset"]["id"])
    amount   = int(pay_json["payment"]["amount"])
    pay_to   = pay_json["payment"]["payTo"]
    memo     = pay_json.get("memo", "x402")

    toll_txn = algosdk.transaction.AssetTransferTxn(
        sender     = sender_addr,
        sp         = params,
        receiver   = pay_to,
        amt        = amount,
        index      = asset_id,
        note       = memo.encode(),
    )

    # Assign to a single-txn group so groupId is defined
    algosdk.transaction.assign_group_id([toll_txn])

    group_id_bytes = toll_txn.group
    group_id_b64   = base64.b64encode(group_id_bytes).decode()

    signed_txn = toll_txn.sign(private_key)
    signed_b64 = base64.b64encode(
        algosdk.encoding.msgpack_encode(signed_txn).encode("latin-1")
        if isinstance(algosdk.encoding.msgpack_encode(signed_txn), str)
        else algosdk.encoding.msgpack_encode(signed_txn)
    ).decode()

    timestamp = int(time.time())
    nonce     = str(uuid.uuid4())

    sig_payload = f"{group_id_b64}:{timestamp}:{nonce}".encode()
    signature   = base64.b64encode(algosdk.util.sign_bytes(sig_payload, private_key)).decode()

    proof = {
        "groupId":      group_id_b64,
        "transactions": [signed_b64],
        "senderAddr":   sender_addr,
        "signature":    signature,
        "timestamp":    timestamp,
        "nonce":        nonce,
    }

    return base64.b64encode(json.dumps(proof).encode()).decode()


def request_with_payment(
    url:          str,
    method:       str,
    headers:      dict[str, str],
    body:         dict[str, Any] | None,
    private_key:  str,
    sender_addr:  str,
    node_url:     str = _DEFAULT_NODE_URL,
    max_retries:  int = 2,
    timeout:      int = 30,
) -> requests.Response:
    """
    Make an HTTP request, transparently absorbing any 402 challenge.

    Returns the final non-402 response (caller should check .ok).
    Raises X402Error on unrecoverable failures.
    """
    last_error: X402Error | None = None

    for attempt in range(max_retries + 1):
        if attempt > 0:
            time.sleep(0.5 * (2 ** (attempt - 1)))

        try:
            resp = requests.request(
                method  = method,
                url     = url,
                headers = headers,
                json    = body,
                timeout = timeout,
            )
        except requests.RequestException as exc:
            last_error = X402Error(str(exc), X402ErrorCode.NETWORK_ERROR)
            continue

        if resp.status_code != 402:
            return resp

        # ── Parse 402 offer ──────────────────────────────────────
        try:
            pay_json: dict[str, Any] = resp.json()
        except Exception:
            raise X402Error("Failed to parse 402 pay+json body", X402ErrorCode.UNKNOWN)

        if pay_json.get("version") != "x402-v1":
            raise X402Error(
                f"Unsupported x402 version: {pay_json.get('version')}",
                X402ErrorCode.UNSUPPORTED_VERSION,
            )

        expires_at = pay_json.get("expires", "")
        # Basic expiry guard (server enforces exact timing)
        if expires_at and expires_at < time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()):
            raise X402Error("x402 offer expired before proof could be built", X402ErrorCode.OFFER_EXPIRED)

        # ── Build proof and retry ─────────────────────────────────
        try:
            x_payment = _build_proof(pay_json, private_key, sender_addr, node_url)
        except X402Error:
            raise
        except Exception as exc:
            raise X402Error(f"Failed to build payment proof: {exc}", X402ErrorCode.SANDBOX_ERROR)

        retry_headers = {**headers, "X-PAYMENT": x_payment}
        try:
            retry_resp = requests.request(
                method  = method,
                url     = url,
                headers = retry_headers,
                json    = body,
                timeout = timeout,
            )
            return retry_resp
        except requests.RequestException as exc:
            last_error = X402Error(str(exc), X402ErrorCode.NETWORK_ERROR)
            continue

    raise last_error or X402Error("Max retries exceeded", X402ErrorCode.NETWORK_ERROR)
