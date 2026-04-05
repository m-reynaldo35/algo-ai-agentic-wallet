"""AlgorandUsdcMethodData — PaymentMethodData.data for x402 on Algorand.

Use this as the ``data`` dict inside a W3C ``PaymentMethodData`` object when
constructing an AP2 ``CartMandate`` or ``PaymentRequest`` that accepts x402
payments settled on Algorand.

Example::

    from ap2.types.payment_request import PaymentMethodData
    from ap2_algorand import AlgorandUsdcMethodData

    method = PaymentMethodData(
        supported_methods="https://www.x402.org/",
        data=AlgorandUsdcMethodData(
            mandate_app_id=3498113854,
            asset_id=31_566_704,
            network="mainnet",
            x402_endpoint="https://api.example.com/premium",
        ).model_dump(),
    )
"""

from typing import Literal

from pydantic import BaseModel, Field


X402_METHOD_NAME = "https://www.x402.org/"

USDC_MAINNET_ASA_ID = 31_566_704
USDC_TESTNET_ASA_ID = 10_458_941


class AlgorandUsdcMethodData(BaseModel):
    """Configuration data for an Algorand / x402 payment method.

    Carried in ``PaymentMethodData.data`` with
    ``supported_methods="https://www.x402.org/"``.
    """

    mandate_app_id: int = Field(
        ...,
        description=(
            "Algorand application ID of the agent's MandateContract. "
            "The AVM enforces per-tx and velocity caps for this agent."
        ),
    )
    asset_id: int = Field(
        ...,
        description=(
            "Algorand ASA ID for the payment token. "
            f"Mainnet USDC = {USDC_MAINNET_ASA_ID}, "
            f"testnet USDC = {USDC_TESTNET_ASA_ID}."
        ),
    )
    network: Literal["mainnet", "testnet"] = Field(
        "mainnet",
        description="Algorand network.",
    )
    x402_endpoint: str = Field(
        ...,
        description=(
            "The x402-gated API endpoint URL that will receive the payment. "
            "The merchant verifies the signed transaction references this endpoint."
        ),
    )

    @property
    def usdc_asset_id(self) -> int:
        """Convenience: returns the canonical USDC ASA ID for the network."""
        return USDC_MAINNET_ASA_ID if self.network == "mainnet" else USDC_TESTNET_ASA_ID
