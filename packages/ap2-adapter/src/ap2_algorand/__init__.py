"""ap2-algorand — Google AP2 × Algorand x402 adapter.

Bridges the `Google Agent Payments Protocol (AP2)
<https://github.com/google-agentic-commerce/AP2>`_ with Algorand x402
payments.

**Buyer side** — build a ``PaymentMethodData`` for your ``CartMandate``::

    from ap2_algorand import AlgorandUsdcMethodData, X402_METHOD_NAME
    from ap2.types.payment_request import PaymentMethodData

    method = PaymentMethodData(
        supported_methods=X402_METHOD_NAME,
        data=AlgorandUsdcMethodData(
            mandate_app_id=3_498_113_854,
            asset_id=31_566_704,           # mainnet USDC
            network="mainnet",
            x402_endpoint="https://api.example.com/premium",
        ).model_dump(),
    )

**Buyer side** — extract payment args from a ``CartMandate``::

    from ap2_algorand import cart_to_payment_args

    args = cart_to_payment_args(cart_mandate)
    # args.mandate_app_id, args.amount_micro_usdc, args.asset_id, args.x402_endpoint

**Merchant side** — submit payment and get ``PaymentReceipt``::

    from ap2_algorand import settle

    receipt = settle(payment_mandate, algod_url="https://mainnet-api.algonode.cloud")
    # receipt.payment_status.network_confirmation_id == Algorand txid
"""

__version__ = "0.1.0"

from ap2_algorand.payment_method import (
    AlgorandUsdcMethodData,
    X402_METHOD_NAME,
    USDC_MAINNET_ASA_ID,
    USDC_TESTNET_ASA_ID,
)
from ap2_algorand.cart_adapter import (
    AlgorandPaymentArgs,
    cart_to_payment_args,
)
from ap2_algorand.settle import settle, settle_raw

__all__ = [
    # Payment method
    "AlgorandUsdcMethodData",
    "X402_METHOD_NAME",
    "USDC_MAINNET_ASA_ID",
    "USDC_TESTNET_ASA_ID",
    # Cart adapter
    "AlgorandPaymentArgs",
    "cart_to_payment_args",
    # Settlement
    "settle",
    "settle_raw",
]
