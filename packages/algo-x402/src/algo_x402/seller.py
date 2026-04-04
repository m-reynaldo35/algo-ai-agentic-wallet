"""
algo_x402.seller — x402 Algorand payment gating for Python APIs

Decorators and middleware for adding USDC micropayment requirements
to FastAPI and Flask endpoints. Compatible with any buyer using
@algo-wallet/x402-client or algo-x402.

Quick start (FastAPI):

    from fastapi import FastAPI
    from algo_x402.seller import x402

    app = FastAPI()

    @app.post("/api/weather")
    @x402(price=10_000, pay_to="YOUR_ALGORAND_ADDRESS")
    async def get_weather(city: str):
        return {"weather": fetch_weather(city)}

Quick start (Flask):

    from flask import Flask, request, jsonify
    from algo_x402.seller import x402_flask

    app = Flask(__name__)

    @app.post("/api/weather")
    @x402_flask(price=10_000, pay_to="YOUR_ALGORAND_ADDRESS")
    def get_weather():
        return jsonify({"weather": fetch_weather(request.json["city"])})

Payment flow:
    1. No X-PAYMENT header  → 402 with x402-v1 JSON payment terms
    2. Valid X-PAYMENT       → verified + submitted, handler called
    3. Invalid X-PAYMENT     → 402 with error detail

The X-PAYMENT header is a base64-encoded signed MandateContract.pay()
Algorand application call. Buyers build it automatically via
AlgoAgentClient.fetch() or the TypeScript @algo-wallet/x402-client SDK.
"""

from __future__ import annotations

import base64
import struct
import time
import functools
from datetime import datetime, timezone
from typing import Any, Callable, Optional

# ── Optional dependency: py-algorand-sdk ────────────────────────
try:
    import algosdk
    from algosdk import encoding, transaction as atxn
    from algosdk.v2client import algod as algod_client
    _HAS_ALGOSDK = True
except ImportError:
    _HAS_ALGOSDK = False

# ── ARC-4 method selector for pay(address,uint64)void ────────────
# SHA-512/256 of "pay(address,uint64)void", first 4 bytes
_PAY_METHOD_SIG = "pay(address,uint64)void"

def _pay_selector() -> bytes:
    if not _HAS_ALGOSDK:
        raise ImportError("py-algorand-sdk is required. Install: pip install py-algorand-sdk")
    from algosdk.abi import Method
    return Method.get_selector(Method(_PAY_METHOD_SIG))

# ── Network config ────────────────────────────────────────────────

_ALGOD_URLS = {
    "mainnet": "https://mainnet-api.4160.nodely.dev",
    "testnet": "https://testnet-api.4160.nodely.dev",
}

_USDC_ASA_IDS = {
    "mainnet": 31_566_704,
    "testnet": 10_458_941,
}


# ── 402 pay+json builder ─────────────────────────────────────────

def _build_pay_json(
    price: int,
    pay_to: str,
    endpoint: str,
    network: str = "mainnet",
    name: Optional[str] = None,
    description: Optional[str] = None,
    error: Optional[str] = None,
) -> dict[str, Any]:
    asset_id = _USDC_ASA_IDS.get(network, _USDC_ASA_IDS["mainnet"])
    expires  = datetime.fromtimestamp(time.time() + 300, tz=timezone.utc).isoformat()

    payload: dict[str, Any] = {
        "version": "x402-v1",
        "status":  402,
        "network": {"protocol": "algorand", "chain": network},
        "payment": {
            "asset":  {"type": "ASA", "id": asset_id, "symbol": "USDC", "decimals": 6},
            "amount": str(price),
            "payTo":  pay_to,
        },
        "expires": expires,
        "memo":    f"x402:{endpoint}:{int(time.time())}",
    }
    if name:        payload["name"]        = name
    if description: payload["description"] = description
    if error:       payload["error"]       = error
    return payload


# ── Payment verification ──────────────────────────────────────────

def _verify_and_submit(
    x_payment: str,
    pay_to: str,
    price: int,
    algod_url: str,
    submit: bool = True,
) -> tuple[bool, Optional[str], Optional[str]]:
    """
    Returns (ok, txid_or_none, error_or_none).
    ok=True means payment is valid (and submitted if submit=True).
    """
    if not _HAS_ALGOSDK:
        return False, None, "py-algorand-sdk not installed (pip install py-algorand-sdk)"

    try:
        raw_bytes = base64.b64decode(x_payment)
    except Exception:
        return False, None, "Cannot base64-decode X-PAYMENT"

    try:
        import msgpack  # type: ignore
        decoded = msgpack.unpackb(raw_bytes, raw=True)
        # algosdk transaction bytes: {"sig": ..., "txn": {...}}
        # Use algosdk's own decoder for reliability
        signed_txn = algosdk.encoding.future_msgpack_decode(x_payment)
    except Exception as e:
        return False, None, f"Cannot decode X-PAYMENT transaction: {e}"

    try:
        txn = signed_txn.transaction
    except AttributeError:
        return False, None, "X-PAYMENT is not a signed transaction"

    # Must be application call (type = "appl")
    if not hasattr(txn, "index") or not hasattr(txn, "app_args"):
        return False, None, "X-PAYMENT must be an application call"

    app_args: list[bytes] = txn.app_args or []
    if len(app_args) < 3:
        return False, None, "pay() requires 3 app args (selector + recipient + amount)"

    # Verify method selector
    try:
        expected_selector = _pay_selector()
        if app_args[0] != expected_selector:
            return False, None, "Application call is not pay(address,uint64)void"
    except Exception as e:
        return False, None, f"Selector check failed: {e}"

    # Decode recipient (32 raw bytes → Algorand address)
    try:
        recipient = encoding.encode_address(app_args[1])
    except Exception:
        return False, None, "Cannot decode recipient address from app args"

    # Decode amount (uint64 big-endian)
    try:
        (amount_micro_usdc,) = struct.unpack(">Q", app_args[2])
    except Exception:
        return False, None, "Cannot decode payment amount from app args"

    # Verify recipient
    if recipient != pay_to:
        return False, None, f"Recipient mismatch. Expected {pay_to}, got {recipient}"

    # Verify amount
    if amount_micro_usdc < price:
        return False, None, f"Amount too low. Expected >= {price} µUSDC, got {amount_micro_usdc}"

    if not submit:
        return True, None, None

    # Submit
    try:
        client = algod_client.AlgodClient("", algod_url)
        result = client.send_raw_transaction(base64.b64decode(x_payment))
        return True, result, None
    except Exception as e:
        return False, None, f"Transaction submission failed: {e}"


# ── FastAPI decorator ─────────────────────────────────────────────

def x402(
    price: int,
    pay_to: str,
    network: str = "mainnet",
    algod_url: Optional[str] = None,
    name: Optional[str] = None,
    description: Optional[str] = None,
) -> Callable:
    """
    FastAPI route decorator that requires an x402 USDC micropayment.

    Args:
        price:       Payment amount in µUSDC (1 USDC = 1,000,000 µUSDC)
        pay_to:      Your Algorand address — receives the payment
        network:     "mainnet" (default) or "testnet"
        algod_url:   Override Algod endpoint
        name:        Tool name shown in 402 response
        description: Description shown in 402 response

    The decorated handler receives an extra kwarg `x402_payment: dict` with:
        txid        — Algorand transaction ID
        sender_addr — Payer's Algorand address
    """
    resolved_algod = algod_url or _ALGOD_URLS.get(network, _ALGOD_URLS["mainnet"])

    def decorator(func: Callable) -> Callable:
        import inspect
        is_async = inspect.iscoroutinefunction(func)

        if is_async:
            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                # FastAPI injects Request as a dependency — find it
                from fastapi import Request
                from fastapi.responses import JSONResponse

                request: Optional[Request] = None
                for arg in args:
                    if isinstance(arg, Request):
                        request = arg
                        break
                for v in kwargs.values():
                    if isinstance(v, Request):
                        request = v
                        break

                if request is None:
                    # No Request object — can't check headers; inject Request dep
                    raise RuntimeError(
                        "x402 decorator requires a FastAPI Request parameter in the handler. "
                        "Add `request: Request` to your function signature."
                    )

                endpoint  = str(request.url.path)
                x_payment = request.headers.get("x-payment") or request.headers.get("X-PAYMENT")

                if not x_payment:
                    return JSONResponse(
                        status_code=402,
                        content=_build_pay_json(price, pay_to, endpoint, network, name, description),
                        media_type="application/pay+json",
                    )

                ok, txid, error = _verify_and_submit(
                    x_payment, pay_to, price, resolved_algod
                )

                if not ok:
                    return JSONResponse(
                        status_code=402,
                        content=_build_pay_json(price, pay_to, endpoint, network, name, description, error),
                        media_type="application/pay+json",
                    )

                kwargs["x402_payment"] = {"txid": txid, "sender_addr": None}
                return await func(*args, **kwargs)

            return async_wrapper

        else:
            @functools.wraps(func)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                from fastapi import Request
                from fastapi.responses import JSONResponse

                request = None
                for arg in args:
                    if isinstance(arg, Request):
                        request = arg
                        break
                for v in kwargs.values():
                    if isinstance(v, Request):
                        request = v
                        break

                if request is None:
                    raise RuntimeError(
                        "x402 decorator requires a FastAPI Request parameter in the handler."
                    )

                endpoint  = str(request.url.path)
                x_payment = request.headers.get("x-payment") or request.headers.get("X-PAYMENT")

                if not x_payment:
                    return JSONResponse(
                        status_code=402,
                        content=_build_pay_json(price, pay_to, endpoint, network, name, description),
                        media_type="application/pay+json",
                    )

                ok, txid, error = _verify_and_submit(
                    x_payment, pay_to, price, resolved_algod
                )

                if not ok:
                    return JSONResponse(
                        status_code=402,
                        content=_build_pay_json(price, pay_to, endpoint, network, name, description, error),
                        media_type="application/pay+json",
                    )

                kwargs["x402_payment"] = {"txid": txid, "sender_addr": None}
                return func(*args, **kwargs)

            return sync_wrapper

    return decorator


# ── Flask middleware ──────────────────────────────────────────────

def x402_flask(
    price: int,
    pay_to: str,
    network: str = "mainnet",
    algod_url: Optional[str] = None,
    name: Optional[str] = None,
    description: Optional[str] = None,
) -> Callable:
    """
    Flask route decorator that requires an x402 USDC micropayment.

    Args:
        price:       Payment amount in µUSDC
        pay_to:      Your Algorand address
        network:     "mainnet" (default) or "testnet"
        algod_url:   Override Algod endpoint
        name:        Tool name shown in 402 response
        description: Description shown in 402 response

    Usage:
        from flask import Flask, request, jsonify, g
        from algo_x402.seller import x402_flask

        app = Flask(__name__)

        @app.post("/api/weather")
        @x402_flask(price=10_000, pay_to="YOUR_ADDR")
        def get_weather():
            txid = g.x402_payment["txid"]
            return jsonify({"weather": "sunny", "txid": txid})
    """
    resolved_algod = algod_url or _ALGOD_URLS.get(network, _ALGOD_URLS["mainnet"])

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            from flask import request as flask_request, jsonify, g  # type: ignore

            endpoint  = flask_request.path
            x_payment = (
                flask_request.headers.get("X-PAYMENT") or
                flask_request.headers.get("x-payment")
            )

            if not x_payment:
                response = jsonify(
                    _build_pay_json(price, pay_to, endpoint, network, name, description)
                )
                response.status_code = 402
                response.content_type = "application/pay+json"
                return response

            ok, txid, error = _verify_and_submit(
                x_payment, pay_to, price, resolved_algod
            )

            if not ok:
                response = jsonify(
                    _build_pay_json(price, pay_to, endpoint, network, name, description, error)
                )
                response.status_code = 402
                response.content_type = "application/pay+json"
                return response

            g.x402_payment = {"txid": txid}
            return func(*args, **kwargs)

        return wrapper

    return decorator
