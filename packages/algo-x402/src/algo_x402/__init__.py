"""
algo-x402 — Python SDK for x402 AI-to-AI payments on Algorand

Buyer quickstart:
    from algo_x402 import AlgoAgentClient

    client = AlgoAgentClient(
        mnemonic  = "word1 word2 ... word25",
        agent_id  = "my-agent-001",
        base_url  = "https://api.ai-agentic-wallet.com",
    )
    result = client.execute_trade(amount_usdc=0.01)
    print(result.txn_id)

Seller quickstart (FastAPI):
    from fastapi import FastAPI, Request
    from algo_x402 import x402

    app = FastAPI()

    @app.post("/api/weather")
    @x402(price=10_000, pay_to="YOUR_ALGORAND_ADDRESS")
    async def get_weather(request: Request, city: str, x402_payment: dict = None):
        return {"weather": fetch_weather(city), "txid": x402_payment["txid"]}

Seller quickstart (Flask):
    from flask import Flask, request, jsonify, g
    from algo_x402 import x402_flask

    app = Flask(__name__)

    @app.post("/api/weather")
    @x402_flask(price=10_000, pay_to="YOUR_ALGORAND_ADDRESS")
    def get_weather():
        return jsonify({"weather": fetch_weather(request.json["city"])})
"""

from .client import AlgoAgentClient
from .seller import x402, x402_flask
from .types import (
    TradeResult,
    SettlementResult,
    VelocityBlock,
    AgentInfo,
    X402Error,
    X402ErrorCode,
    DestinationChain,
)

__all__ = [
    # Buyer
    "AlgoAgentClient",
    "TradeResult",
    "SettlementResult",
    "VelocityBlock",
    "AgentInfo",
    "X402Error",
    "X402ErrorCode",
    "DestinationChain",
    # Seller
    "x402",
    "x402_flask",
]

__version__ = "0.2.0"
