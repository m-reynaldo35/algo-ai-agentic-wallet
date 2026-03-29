# algo-x402

Python SDK for [x402](https://x402.org) AI-to-AI payments on Algorand USDC.

## Install

```bash
pip install algo-x402
```

## Quickstart

```python
from algo_x402 import AlgoAgentClient

client = AlgoAgentClient(
    mnemonic  = "word1 word2 ... word25",
    agent_id  = "my-agent-001",
    base_url  = "https://api.ai-agentic-wallet.com",
)

# Execute a payment via the x402 payment rail
result = client.execute_trade(amount_usdc=0.01)
print(result.txn_id)
```

## Requirements

- Python ≥ 3.10
- `py-algorand-sdk >= 2.0`

## Links

- [Documentation](https://ai-agentic-wallet.com/docs)
- [npm TypeScript SDK](https://www.npmjs.com/package/@algo-wallet/x402-client)
- [GitHub](https://github.com/algo-wallet/algo-wallet)
