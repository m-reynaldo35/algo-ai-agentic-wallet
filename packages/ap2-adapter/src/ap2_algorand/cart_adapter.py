"""cart_to_payment_args — extract Algorand payment parameters from an AP2 CartMandate.

Converts the merchant-signed AP2 ``CartMandate`` into the concrete arguments
needed to build and sign an Algorand MandateContract.pay() transaction.

Usage::

    from ap2_algorand import cart_to_payment_args

    args = cart_to_payment_args(cart_mandate)
    # args.mandate_app_id, args.amount_micro_usdc, args.asset_id, args.x402_endpoint
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ap2_algorand.payment_method import AlgorandUsdcMethodData, X402_METHOD_NAME


@dataclass
class AlgorandPaymentArgs:
    """Parameters extracted from an AP2 CartMandate for Algorand payment."""

    mandate_app_id: int
    """Algorand application ID of the buyer's MandateContract."""

    asset_id: int
    """Algorand ASA ID for the payment token (USDC)."""

    amount_micro_usdc: int
    """Payment amount in micro-USDC (value × 1_000_000)."""

    x402_endpoint: str
    """The x402-gated endpoint being paid for."""

    network: str
    """Algorand network ('mainnet' or 'testnet')."""


def cart_to_payment_args(cart_mandate: Any) -> AlgorandPaymentArgs:
    """Extract Algorand payment parameters from an AP2 CartMandate.

    Locates the ``https://www.x402.org/`` entry in the cart's
    ``payment_request.method_data``, parses it as
    :class:`~ap2_algorand.AlgorandUsdcMethodData`, and converts the cart
    total to micro-USDC.

    Args:
        cart_mandate: An AP2 ``CartMandate`` instance (or any object with a
            compatible ``.contents.payment_request`` attribute).

    Returns:
        :class:`AlgorandPaymentArgs` ready to pass to the x402 buyer client.

    Raises:
        ValueError: If no x402 Algorand payment method is found in the cart.
    """
    payment_request = cart_mandate.contents.payment_request

    # Locate the x402 payment method entry
    x402_method_data: AlgorandUsdcMethodData | None = None
    for method in payment_request.method_data:
        if method.supported_methods == X402_METHOD_NAME:
            data = method.data or {}
            x402_method_data = AlgorandUsdcMethodData(**data)
            break

    if x402_method_data is None:
        available = [m.supported_methods for m in payment_request.method_data]
        raise ValueError(
            f"No x402 Algorand payment method found in CartMandate. "
            f"Available methods: {available}"
        )

    # Convert total to micro-USDC.
    # PaymentCurrencyAmount.value is a float USD amount; 1 USDC = 1_000_000 µUSDC.
    total = payment_request.details.total
    amount_float: float = float(total.amount.value)
    amount_micro_usdc = round(amount_float * 1_000_000)

    return AlgorandPaymentArgs(
        mandate_app_id=x402_method_data.mandate_app_id,
        asset_id=x402_method_data.asset_id,
        amount_micro_usdc=amount_micro_usdc,
        x402_endpoint=x402_method_data.x402_endpoint,
        network=x402_method_data.network,
    )
