"""
algo-x402 — Python SDK for x402 AI-to-AI payments on Algorand

Quickstart:
    from algo_x402 import AlgoAgentClient

    client = AlgoAgentClient(
        mnemonic  = "word1 word2 ... word25",
        agent_id  = "my-agent-001",
        base_url  = "https://api.ai-agentic-wallet.com",
    )
    result = client.execute_trade(amount_usdc=0.01)
    print(result.txn_id)
"""

from .client import AlgoAgentClient
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
    "AlgoAgentClient",
    "TradeResult",
    "SettlementResult",
    "VelocityBlock",
    "AgentInfo",
    "X402Error",
    "X402ErrorCode",
    "DestinationChain",
]

__version__ = "0.1.0"
