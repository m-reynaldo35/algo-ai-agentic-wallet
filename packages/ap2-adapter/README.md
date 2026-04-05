# ap2-algorand

**Google AP2 × Algorand x402 adapter** — settle AI agent payments on Algorand from an AP2 `PaymentMandate`.

Bridges the [Google Agent Payments Protocol (AP2)](https://github.com/google-agentic-commerce/AP2) with non-custodial USDC payments on Algorand, enforced by AVM MandateContracts.

## Install

```bash
pip install ap2-algorand
```

## Quick start

### Buyer: advertise x402 Algorand in a CartMandate

```python
from ap2_algorand import AlgorandUsdcMethodData, X402_METHOD_NAME
from ap2.types.payment_request import PaymentMethodData

method = PaymentMethodData(
    supported_methods=X402_METHOD_NAME,   # "https://www.x402.org/"
    data=AlgorandUsdcMethodData(
        mandate_app_id=3_498_113_854,     # agent's MandateContract app ID
        asset_id=31_566_704,              # mainnet USDC ASA
        network="mainnet",
        x402_endpoint="https://api.example.com/weather",
    ).model_dump(),
)
```

### Buyer: parse payment args from a CartMandate

```python
from ap2_algorand import cart_to_payment_args

args = cart_to_payment_args(cart_mandate)
# args.mandate_app_id  → int
# args.amount_micro_usdc → int  (e.g. 10_000 for $0.01 USDC)
# args.asset_id        → int
# args.x402_endpoint   → str
```

### Merchant: submit payment and get a PaymentReceipt

```python
import os
from ap2_algorand import settle

receipt = settle(
    payment_mandate=payment_mandate,
    algod_url="https://mainnet-api.algonode.cloud",
)
txid = receipt.payment_status.network_confirmation_id
# txid == Algorand transaction ID (network IS the ledger)
```

### Lower-level: submit without AP2 types

```python
from ap2_algorand import settle_raw

txid = settle_raw(
    x_payment="<base64-msgpack-signed-tx>",
    algod_url="https://mainnet-api.algonode.cloud",
)
```

## How it maps to AP2

| AP2 field | Algorand value |
|---|---|
| `payment_response.method_name` | `https://www.x402.org/` |
| `payment_response.details["value"]` | `base64(msgpack(SignedTransaction))` |
| `merchant_confirmation_id` | Algorand txid |
| `psp_confirmation_id` | Algorand txid (AVM is the PSP) |
| `network_confirmation_id` | Algorand txid (Algorand is the network) |
| OTP challenge | skipped — AVM MandateContract enforces limits |

## Dependencies

- `py-algorand-sdk >= 2.0`
- `pydantic >= 2.0`
- `ap2` — optional, only needed for `settle()` return type (`PaymentReceipt`)

## License

MIT © Algo Wallet
