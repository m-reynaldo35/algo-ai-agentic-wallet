"""settle — submit an x402 Algorand payment and return an AP2 PaymentReceipt.

This is the merchant-side counterpart: given an AP2 ``PaymentMandate`` whose
``payment_response.details["value"]`` carries a base64-encoded msgpack
``SignedTransaction`` (the x402 payment header), submit it to Algorand and
return a fully-formed AP2 ``PaymentReceipt``.

The Algorand transaction ID serves as all three confirmation IDs:

* ``merchant_confirmation_id`` — the merchant records the txid
* ``psp_confirmation_id``      — Algorand IS the PSP (self-custodial mandate)
* ``network_confirmation_id``  — Algorand IS the network

Usage (merchant payment processor agent)::

    import os
    from ap2_algorand import settle

    receipt = settle(
        payment_mandate=payment_mandate,
        algod_url=os.environ["ALGOD_URL"],          # e.g. https://mainnet-api.algonode.cloud
        algod_token=os.environ.get("ALGOD_TOKEN", ""),
        wait_rounds=4,
    )
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timezone
from typing import Any

import algosdk
from algosdk.v2client import algod

from ap2_algorand.payment_method import X402_METHOD_NAME


def settle(
    payment_mandate: Any,
    algod_url: str,
    algod_token: str = "",
    wait_rounds: int = 4,
) -> Any:
    """Submit an x402 Algorand payment and return an AP2 PaymentReceipt.

    Reads the signed transaction from
    ``payment_mandate.payment_mandate_contents.payment_response.details["value"]``,
    submits it to the Algorand network, waits for on-chain confirmation, and
    returns a ``PaymentReceipt`` with the transaction ID as the confirmation ID.

    Args:
        payment_mandate: An AP2 ``PaymentMandate`` instance.
        algod_url: Algod REST endpoint (e.g. ``https://mainnet-api.algonode.cloud``).
        algod_token: Algod API token. Empty string for public nodes.
        wait_rounds: Maximum rounds to wait for confirmation (default 4).

    Returns:
        An AP2 ``PaymentReceipt`` (``payment_status`` is ``Success``).

    Raises:
        ValueError: If the payment_response is missing or has no x402 value.
        algosdk.error.AlgodHTTPError: On algod submission failure.
        Exception: If confirmation times out.
    """
    # ── 1. Extract signed transaction bytes ───────────────────────────────────
    contents = payment_mandate.payment_mandate_contents
    response = contents.payment_response

    if response.method_name != X402_METHOD_NAME:
        raise ValueError(
            f"Expected payment method '{X402_METHOD_NAME}', "
            f"got '{response.method_name}'"
        )

    x_payment: str | None = (response.details or {}).get("value")
    if not x_payment:
        raise ValueError(
            "PaymentMandate.payment_response.details['value'] is missing. "
            "The buyer agent must set this to the base64-encoded x402 SignedTransaction."
        )

    stxn_bytes = base64.b64decode(x_payment)

    # ── 2. Submit to Algorand ─────────────────────────────────────────────────
    algod_client = algod.AlgodClient(algod_token, algod_url)
    txid: str = algod_client.send_raw_transaction(stxn_bytes)

    # ── 3. Wait for on-chain confirmation ─────────────────────────────────────
    algosdk.util.wait_for_confirmation(algod_client, txid, wait_rounds)

    # ── 4. Build PaymentReceipt ───────────────────────────────────────────────
    # Import AP2 types at call time so the package works without ap2 installed
    # (e.g. for testing or non-AP2 use of the settle logic alone).
    try:
        from ap2.types.payment_receipt import PaymentReceipt, Success  # type: ignore[import]
        from ap2.types.payment_request import PaymentCurrencyAmount    # type: ignore[import]
    except ImportError as exc:
        raise ImportError(
            "ap2 package is required to build a PaymentReceipt. "
            "Install it with: pip install ap2"
        ) from exc

    payment_id = uuid.uuid4().hex
    payment_mandate_id = contents.payment_mandate_id
    total_item = contents.payment_details_total

    return PaymentReceipt(
        payment_mandate_id=payment_mandate_id,
        timestamp=datetime.now(timezone.utc).isoformat(),
        payment_id=payment_id,
        amount=PaymentCurrencyAmount(
            currency=total_item.amount.currency,
            value=total_item.amount.value,
        ),
        payment_status=Success(
            merchant_confirmation_id=txid,
            psp_confirmation_id=txid,
            network_confirmation_id=txid,
        ),
        payment_method_details={
            "method_name": X402_METHOD_NAME,
            "network": "algorand",
            "txid": txid,
        },
    )


def settle_raw(
    x_payment: str,
    algod_url: str,
    algod_token: str = "",
    wait_rounds: int = 4,
) -> str:
    """Submit a raw x402 payment header to Algorand and return the txid.

    Lower-level alternative to :func:`settle` that works without AP2 types.
    Useful for testing or non-AP2 contexts.

    Args:
        x_payment: Base64-encoded msgpack SignedTransaction (the X-PAYMENT header value).
        algod_url: Algod REST endpoint.
        algod_token: Algod API token. Empty string for public nodes.
        wait_rounds: Maximum rounds to wait for confirmation.

    Returns:
        Algorand transaction ID string.
    """
    stxn_bytes = base64.b64decode(x_payment)
    algod_client = algod.AlgodClient(algod_token, algod_url)
    txid: str = algod_client.send_raw_transaction(stxn_bytes)
    algosdk.util.wait_for_confirmation(algod_client, txid, wait_rounds)
    return txid
