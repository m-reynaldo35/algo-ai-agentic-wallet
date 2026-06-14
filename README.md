# Algo AI Agentic Wallet

**x402-compliant payment infrastructure for AI agents on Algorand.**

AI agents can pay for API calls on-chain in USDC — autonomously, without human approval — with spending limits enforced by smart contracts on the AVM.

**Live API:** `https://api.ai-agentic-wallet.com`  
**Developer portal:** `https://ai-agentic-wallet.com`

---

## How it works

The [x402 protocol](https://x402.org) turns any HTTP API into a pay-per-call service. When an agent hits a paywalled endpoint it gets a `402 Payment Required` response with USDC terms. The SDK pays automatically and retries — the agent receives the data, the payment settles on-chain.

```
Agent → POST /api/agent-action
           ↳ 402 { amount: 10000 µUSDC, payTo: "ALGO..." }
Agent → builds USDC transfer + Ed25519 proof
Agent → POST /api/agent-action (X-PAYMENT header)
           ↳ 200 { data: ... }   ← settled on Algorand mainnet
```

Every payment is an irreversible on-chain USDC transaction. No escrow, no intermediary, no partial settlement.

---

## Quickstart (TypeScript)

```bash
npm install @algo-wallet/x402-client algosdk
```

```typescript
import { AlgoAgentClient } from "@algo-wallet/x402-client";
import algosdk from "algosdk";

const account = algosdk.mnemonicToSecretKey("word1 word2 ... word25");

const client = new AlgoAgentClient({
  baseUrl: "https://api.ai-agentic-wallet.com",
  privateKey: account.sk,
  mandateAppId: YOUR_MANDATE_APP_ID,  // deploy one via POST /api/agents/create-mandate
});

const result = await client.executeTrade({
  senderAddress: account.addr.toString(),
  amount: 10000,  // micro-USDC — $0.01
});
// { success: true, settlement: { txnId: "...", confirmedRound: 12345678 } }
```

The SDK handles the full 402 handshake invisibly. Three lines of code.

---

## Quickstart (Python)

```bash
pip install algo-x402
```

```python
from algo_x402 import AlgoX402Client

client = AlgoX402Client(
    base_url="https://api.ai-agentic-wallet.com",
    mnemonic="word1 word2 ... word25",
    mandate_app_id=YOUR_MANDATE_APP_ID,
)

result = client.execute_trade(amount=10000)
print(result["settlement"]["txn_id"])
```

---

## Mandate Contracts

Spending limits live on-chain — not in a database the operator can change.

Each agent deploys a **MandateContract** (PyTEAL/AVM) that enforces:
- Per-execution toll cap
- Daily USDC velocity cap
- Operator-signed authorisation required for each payment

```bash
# Deploy a MandateContract for your agent
curl -X POST https://api.ai-agentic-wallet.com/api/agents/create-mandate \
  -H "X-Portal-Key: YOUR_KEY" \
  -d '{"agentId": "my-agent", "address": "ALGO_ADDRESS"}'
```

The MandateFactory is deployed on Algorand mainnet at app ID `3498110794`.

---

## Benchmark — Algorand Mainnet

100 real payments, no mocks, no testnet.

| Metric | Value |
|--------|-------|
| Success rate | **100 / 100** |
| Throughput | **126.6 tx/min** |
| x402 handshake p50 | 549 ms |
| End-to-end p50 | 10.7 s |
| End-to-end p95 | 15.4 s |
| Peak concurrency | 46 in-flight |

Live results: `GET https://api.ai-agentic-wallet.com/api/benchmark`

Sample on-chain receipts:
- [`S7QJRCIS…`](https://explorer.perawallet.app/tx/S7QJRCIS7PXUXWHIQPU2IL7MYW2BUEC753TTAZYKITKI2QJXYWRQ)
- [`DOBY7VLE…`](https://explorer.perawallet.app/tx/DOBY7VLEVQWVMOFU6PNC7A53BZZGXEYBK3O54JQYHOS3VY4D4KZA)

---

## Packages

| Package | Language | Description |
|---------|----------|-------------|
| [`packages/x402-client`](./packages/x402-client) | TypeScript | SDK — handles 402 handshake automatically |
| [`packages/x402-mcp`](./packages/x402-mcp) | TypeScript | MCP server for Claude Desktop / Claude Code |
| [`packages/algo-x402`](./packages/algo-x402) | Python | Python SDK |
| [`packages/x402-cli`](./packages/x402-cli) | TypeScript | CLI — `health`, `balance`, `agents list`, `mandate list` |
| [`packages/ap2-adapter`](./packages/ap2-adapter) | Python | AP2 cart adapter |
| [`apps/developer-portal`](./apps/developer-portal) | Next.js | Self-serve dashboard for agent owners |
| [`contracts/pyteal`](./contracts/pyteal) | PyTEAL | MandateContract + MandateFactory AVM source |

---

## MCP Server (Claude Desktop / Claude Code)

```bash
npx @algo-wallet/x402-mcp
```

Adds x402 payment tools to any MCP-compatible AI:
- `x402_pay` — execute a payment against any x402 endpoint
- `x402_balance` — check agent USDC balance
- `x402_mandate` — query mandate contract state

---

## CLI

```bash
npx @algo-wallet/x402-cli health
npx @algo-wallet/x402-cli balance --agent MY_AGENT_ID
npx @algo-wallet/x402-cli agents list
npx @algo-wallet/x402-cli mandate list --agent MY_AGENT_ID
```

Set `X402_API_URL`, `X402_PORTAL_KEY`, `X402_NETWORK` in your environment.

---

## Self-hosting

```bash
git clone https://github.com/m-reynaldo35/algo-ai-agentic-wallet
cd algo-ai-agentic-wallet
cp .env.example .env
# Fill in ALGORAND_MNEMONIC, X402_PAY_TO_ADDRESS, REDIS_URL
npm install
npm run dev
```

Requires: Node 20+, an Algorand mainnet account with USDC opted-in, Redis (Upstash free tier works).

See [`.env.example`](./.env.example) for the full variable reference.

Deploy to Railway with one click: the `railway.json` and `Dockerfile` are included.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  AI Agent (any language)                                │
│  x402-client / algo-x402 / MCP / raw HTTP              │
└──────────────────────┬──────────────────────────────────┘
                       │ x402 handshake
┌──────────────────────▼──────────────────────────────────┐
│  API Server (Express / Railway)                         │
│  • x402 paywall middleware                              │
│  • Replay guard (Redis nonce cache)                     │
│  • Velocity engine + burst guard                        │
│  • Mandate verifier (on-chain spend check)              │
└──────────────────────┬──────────────────────────────────┘
                       │ atomic USDC transfer
┌──────────────────────▼──────────────────────────────────┐
│  Algorand Mainnet                                       │
│  • MandateContract (PyTEAL) — enforces spend limits     │
│  • Circle USDC (ASA 31566704)                           │
│  • Falcon-512 state proofs — PQ-safe finality           │
└─────────────────────────────────────────────────────────┘
```

---

## Safety

- **On-chain spend limits** — MandateContract rejects over-limit payments at the AVM level
- **Velocity guard** — Redis sliding window; auto-halt on drain detection
- **Daily USDC cap** — configurable per-signer ceiling, halts on breach  
- **Replay protection** — timestamp + nonce; 30s clock-skew tolerance
- **Cold wallet sweep** — SHA-256 address anchor in Redis; mismatch blocks sweeps

See [`SAFETY.md`](./SAFETY.md) for the full threat model.

---

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md).

---

## License

MIT
