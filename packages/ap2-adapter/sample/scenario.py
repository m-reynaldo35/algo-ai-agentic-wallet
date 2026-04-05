"""AP2 × Algorand x402 — end-to-end sample scenario.

Demonstrates the full mandate chain for an autonomous (human-not-present)
x402 payment on Algorand:

  IntentMandate → CartMandate → PaymentMandate → settle → PaymentReceipt

This script can run standalone (no real Algorand key required) to validate
the AP2 type wiring. Set SUBMIT=1 to actually broadcast to Algorand.

Environment variables:
    ALGO_MNEMONIC    — 25-word agent mnemonic (required if SUBMIT=1)
    MANDATE_APP_ID   — agent's MandateContract app ID (required if SUBMIT=1)
    ALGOD_URL        — algod endpoint (default: mainnet public node)
    ALGOD_TOKEN      — algod token (default: empty, for public nodes)
    SUBMIT           — set to "1" to broadcast the transaction
"""

from __future__ import annotations

import base64
import os
import uuid
from datetime import datetime, timezone

# ── AP2 types ─────────────────────────────────────────────────────────────────
# pip install ap2  (from google-agentic-commerce/AP2 once published to PyPI)
# For now, copy the src/ap2 directory into your PYTHONPATH.
from ap2.types.mandate import (
    CartContents,
    CartMandate,
    IntentMandate,
    PaymentMandate,
    PaymentMandateContents,
)
from ap2.types.payment_receipt import PaymentReceipt, Success
from ap2.types.payment_request import (
    PaymentCurrencyAmount,
    PaymentDetailsInit,
    PaymentItem,
    PaymentMethodData,
    PaymentRequest,
    PaymentResponse,
)

# ── Algorand adapter ──────────────────────────────────────────────────────────
from ap2_algorand import (
    AlgorandPaymentArgs,
    AlgorandUsdcMethodData,
    X402_METHOD_NAME,
    cart_to_payment_args,
    settle,
    settle_raw,
)

# ── Config ────────────────────────────────────────────────────────────────────
ALGOD_URL    = os.environ.get("ALGOD_URL", "https://mainnet-api.algonode.cloud")
ALGOD_TOKEN  = os.environ.get("ALGOD_TOKEN", "")
MNEMONIC     = os.environ.get("ALGO_MNEMONIC", "")
APP_ID       = int(os.environ.get("MANDATE_APP_ID", "0"))
SHOULD_SUBMIT = os.environ.get("SUBMIT", "0") == "1"

# Demo x402 endpoint — in production this is the real gated API URL
X402_ENDPOINT = "https://api.ai-agentic-wallet.com/demo/weather"
PAY_TO_ADDR   = "C66AFZ3V5XN4ZHCXW6QQT4O6XDHMKSXITIWN4CRTMJUAKFCCH5QE4C2U74"
PRICE_USDC    = 0.01         # $0.01 per call
PRICE_MICRO   = 10_000       # 10,000 µUSDC


# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — Shopping agent builds IntentMandate
# ─────────────────────────────────────────────────────────────────────────────

def build_intent_mandate() -> IntentMandate:
    return IntentMandate(
        user_cart_confirmation_required=False,   # autonomous (human-not-present)
        natural_language_description="Current weather data for London, UK",
        intent_expiry=datetime(2026, 12, 31, tzinfo=timezone.utc).isoformat(),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Step 2 — Merchant agent builds and signs CartMandate
# ─────────────────────────────────────────────────────────────────────────────

def build_cart_mandate(mandate_app_id: int) -> CartMandate:
    payment_item = PaymentItem(
        label="Weather API call — London",
        amount=PaymentCurrencyAmount(currency="USDC", value=PRICE_USDC),
    )
    x402_data = AlgorandUsdcMethodData(
        mandate_app_id=mandate_app_id,
        asset_id=31_566_704,    # mainnet USDC
        network="mainnet",
        x402_endpoint=X402_ENDPOINT,
    )
    cart_contents = CartContents(
        id=uuid.uuid4().hex,
        user_cart_confirmation_required=False,
        payment_request=PaymentRequest(
            method_data=[
                PaymentMethodData(
                    supported_methods=X402_METHOD_NAME,
                    data=x402_data.model_dump(),
                )
            ],
            details=PaymentDetailsInit(
                id=uuid.uuid4().hex,
                display_items=[payment_item],
                total=payment_item,
            ),
        ),
    )
    # In production, merchant signs cart_contents → merchant_authorization JWT.
    # For this demo we leave it unsigned.
    return CartMandate(contents=cart_contents, merchant_authorization=None)


# ─────────────────────────────────────────────────────────────────────────────
# Step 3 — Buyer agent signs Algorand tx and builds PaymentMandate
# ─────────────────────────────────────────────────────────────────────────────

def build_payment_mandate(
    cart: CartMandate,
    args: AlgorandPaymentArgs,
    x_payment: str,
) -> PaymentMandate:
    """Build a PaymentMandate with the signed Algorand x402 transaction."""
    mandate_id = uuid.uuid4().hex
    return PaymentMandate(
        payment_mandate_contents=PaymentMandateContents(
            payment_mandate_id=mandate_id,
            payment_details_id=cart.contents.id,
            payment_details_total=PaymentItem(
                label="Weather API call — London",
                amount=PaymentCurrencyAmount(currency="USDC", value=PRICE_USDC),
            ),
            payment_response=PaymentResponse(
                request_id=cart.contents.payment_request.details.id,
                method_name=X402_METHOD_NAME,
                details={
                    # x402 signed payload: base64(msgpack(SignedTransaction))
                    "value": x_payment,
                    "network": args.network,
                    "mandate_app_id": args.mandate_app_id,
                },
            ),
            merchant_agent="demo-merchant",
        ),
        user_authorization=None,  # autonomous flow; user pre-authorised mandate
    )


def sign_algorand_tx(args: AlgorandPaymentArgs, mnemonic: str) -> str:
    """Sign a MandateContract.pay() ARC-4 call and return base64 msgpack bytes.

    In production, the buyer agent calls algo_x402.buyer.pay() which handles
    the x402 handshake. Here we build the transaction manually for the demo.
    """
    import algosdk
    from algosdk.v2client import algod as algod_client_module

    client = algod_client_module.AlgodClient(ALGOD_TOKEN, ALGOD_URL)
    sp = client.suggested_params()

    private_key = algosdk.mnemonic.to_private_key(mnemonic)
    sender = algosdk.account.address_from_private_key(private_key)

    # ARC-4 method selector: sha512/256("pay(address,uint64)void")[:4]
    import hashlib, struct
    selector = hashlib.new("sha512_256", b"pay(address,uint64)void").digest()[:4]

    # Encode address argument (32 bytes) and uint64 amount
    pay_to_bytes = algosdk.encoding.decode_address(PAY_TO_ADDR)
    amount_bytes = struct.pack(">Q", args.amount_micro_usdc)

    # ARC-4 method call args: [selector, pay_to (addr), amount (uint64)]
    app_args = [selector, pay_to_bytes, amount_bytes]

    txn = algosdk.transaction.ApplicationCallTxn(
        sender=sender,
        sp=sp,
        index=args.mandate_app_id,
        on_complete=algosdk.transaction.OnComplete.NoOpOC,
        app_args=app_args,
        foreign_assets=[args.asset_id],
        accounts=[PAY_TO_ADDR],
        note=os.urandom(8),   # prevent duplicate txn within same round
    )

    stxn = txn.sign(private_key)
    return base64.b64encode(algosdk.encoding.msgpack_encode(stxn)).decode()


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    print("=== AP2 × Algorand x402 — Sample Scenario ===\n")

    # 1. Intent
    intent = build_intent_mandate()
    print(f"[1] IntentMandate created: {intent.natural_language_description!r}")

    # 2. Cart
    app_id = APP_ID or 3_498_113_854   # fallback to test agent app
    cart = build_cart_mandate(app_id)
    print(f"[2] CartMandate created: cart_id={cart.contents.id[:8]}...")

    # 3. Parse cart → payment args
    args = cart_to_payment_args(cart)
    print(
        f"[3] Payment args: mandate_app_id={args.mandate_app_id}, "
        f"amount={args.amount_micro_usdc} µUSDC, "
        f"endpoint={args.x402_endpoint}"
    )

    # 4. Sign Algorand transaction
    if SHOULD_SUBMIT and MNEMONIC:
        print("[4] Signing Algorand MandateContract.pay() transaction...")
        x_payment = sign_algorand_tx(args, MNEMONIC)
        print(f"    x_payment (first 60 chars): {x_payment[:60]}...")
    else:
        # Dummy payload for dry-run
        x_payment = base64.b64encode(b"\x00" * 64).decode()
        print("[4] Dry-run: using dummy x_payment (set SUBMIT=1 to broadcast)")

    # 5. Build PaymentMandate
    payment_mandate = build_payment_mandate(cart, args, x_payment)
    print(f"[5] PaymentMandate created: id={payment_mandate.payment_mandate_contents.payment_mandate_id[:8]}...")

    # 6. Merchant: settle on Algorand
    if SHOULD_SUBMIT and MNEMONIC:
        print("[6] Submitting to Algorand...")
        receipt = settle(payment_mandate, algod_url=ALGOD_URL, algod_token=ALGOD_TOKEN)
        txid = receipt.payment_status.network_confirmation_id
        print(f"    Confirmed! txid={txid}")
        print(f"    Explorer: https://explorer.perawallet.app/tx/{txid}")
    else:
        print("[6] Dry-run: skipping Algorand submission")
        receipt = None

    print("\n=== Done ===")
    if receipt:
        import json
        print(json.dumps(receipt.model_dump(), indent=2))


if __name__ == "__main__":
    main()
