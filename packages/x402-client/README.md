# @algo-wallet/x402-client

TypeScript SDK for x402-compliant AI-to-AI settlement on Algorand.

Handles the full x402 payment handshake automatically — your agent never sees the `402`.

## Install

```bash
npm install @algo-wallet/x402-client algosdk
```

## Quick Start

```typescript
import { AlgoAgentClient } from "@algo-wallet/x402-client";

const client = new AlgoAgentClient({
  baseUrl: "https://your-x402-server.vercel.app",
  privateKey: yourAlgorandSecretKey, // 64-byte Uint8Array
});

const result = await client.executeTrade({ senderAddress: "AAAA...7Q" });
console.log(result); // { success: true, settlement: { txnId: "...", confirmedRound: 12345 } }
```

Three lines. The SDK absorbs the 402 bounce, builds the Ed25519 proof, and settles the atomic group on-chain.

## What Happens Under the Hood

```
executeTrade()
  │
  ├─ POST /api/agent-action           ← Initial request (no proof)
  │    ↳ 402 Payment Required          ← Server bounces with pay+json terms
  │
  ├─ [interceptor] Parse 402 terms     ← Extract USDC amount, payTo, asset ID
  ├─ [interceptor] Build atomic group  ← ASA transfer to treasury
  ├─ [interceptor] Sign groupId        ← Ed25519 signature with your key
  ├─ [interceptor] Retry with proof    ← X-PAYMENT header injected
  │    ↳ 200 SandboxExport             ← Unsigned atomic group returned
  │
  └─ POST /api/execute                 ← Forward to settlement pipeline
       ↳ 200 SettlementResult          ← On-chain confirmation (txnId, round)
```

## API

### `new AlgoAgentClient(config)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseUrl` | `string` | Yes | x402 server URL |
| `privateKey` | `Uint8Array` | Yes | 64-byte Algorand Ed25519 secret key |
| `slippageBips` | `number` | No | Slippage tolerance (default: 50 = 0.5%) |

### `client.executeTrade(params): Promise<TradeResult>`

Full handshake → settlement in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `senderAddress` | `string` | Yes | Your Algorand address |
| `amount` | `number` | No | Micro-USDC amount |
| `destinationChain` | `string` | No | Wormhole target (default: `"ethereum"`) |
| `destinationRecipient` | `string` | No | Recipient on destination chain |

### `client.requestSandboxExport(params): Promise<AgentActionResponse>`

Performs the 402 handshake only. Returns the `SandboxExport` for inspection before settlement.

### `client.settle(response): Promise<TradeResult>`

Forwards a previously obtained `AgentActionResponse` to `/api/execute`.

## Types

All types are exported for full autocomplete:

```typescript
import type {
  TradeParams,
  TradeResult,
  SettlementResult,
  SettlementFailure,
  SandboxExport,
  PayJson,
} from "@algo-wallet/x402-client";
```

## Error Handling

```typescript
import { X402Error } from "@algo-wallet/x402-client";

try {
  const result = await client.executeTrade({ senderAddress: "AAAA...7Q" });
  if ("success" in result) {
    console.log("Settled:", result.settlement.txnId);
  } else {
    console.error("Pipeline failed at:", result.failedStage, result.detail);
  }
} catch (err) {
  if (err instanceof X402Error) {
    console.error("x402 protocol error:", err.message);
  }
}
```

## License

MIT
