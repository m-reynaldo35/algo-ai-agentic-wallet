# Algo AI Agentic Wallet — x402 Skill Manifest

> **Version:** x402-v1
> **Protocol:** Algo AI Agentic Wallet
> **Network:** Algorand (Testnet / Mainnet)
> **Content-Type:** `text/markdown; charset=utf-8`
> **Audience:** Large Language Models acting as autonomous financial agents

---

## 1. Protocol Overview

The Algo AI Agentic Wallet is a **zero-trust, x402-compliant** AI-to-AI financial routing and settlement protocol on Algorand.

**Critical constraint:** Direct execution is forbidden. Every action request is guarded by the **x402 Payment Required** protocol. You MUST complete a cryptographic payment handshake before any transaction construction or on-chain settlement occurs.

**Settlement guarantees:**
- Algorand atomic transfers — all transactions in a group succeed or all revert.
- Sub-3-second finality (4 confirmation rounds).
- Seedless signing via Rocca Wallet; authentication via Liquid Auth (FIDO2).

**Base URL:** The server endpoint (hereinafter `{BASE_URL}`). Discover it from your environment or configuration. All paths below are relative to `{BASE_URL}`.

---

## 2. The x402 Handshake — Step-by-Step

### 2.1 Step 1: Initial Request (The Bounce)

Send a `POST` to `/api/agent-action` **without** an `X-PAYMENT` header.

**Request:**

```http
POST /api/agent-action HTTP/1.1
Content-Type: application/json

{
  "senderAddress": "<YOUR_ALGORAND_ADDRESS>"
}
```

**Expected response:** `HTTP 402 Payment Required`

```
Content-Type: application/pay+json
```

**You MUST receive a 402.** IF the status code is NOT `402`, THEN abort — the endpoint is unreachable or misconfigured.

### 2.2 Step 2: Parse the 402 Response

The `402` body conforms to the `application/pay+json` schema:

```json
{
  "version": "x402-v1",
  "status": 402,
  "network": {
    "protocol": "algorand",
    "chain": "testnet"
  },
  "payment": {
    "asset": {
      "type": "ASA",
      "id": 10458941,
      "symbol": "USDC",
      "decimals": 6
    },
    "amount": "100000",
    "payTo": "<TREASURY_ALGORAND_ADDRESS>"
  },
  "expires": "<ISO_8601_TIMESTAMP>",
  "memo": "x402:/api/agent-action:<UNIX_MS>",
  "error": "Missing X-PAYMENT header. Submit a signed Algorand atomic group proof."
}
```

**Extract these fields:**

| Field | Path | Description |
|-------|------|-------------|
| `network` | `$.network.chain` | Target Algorand network (`testnet` or `mainnet`) |
| `asset_id` | `$.payment.asset.id` | ASA ID of the required payment token (USDC) |
| `amount` | `$.payment.amount` | Required toll in micro-units (string, 6 decimals) |
| `payTo` | `$.payment.payTo` | Treasury Algorand address receiving the toll |
| `expires` | `$.expires` | ISO 8601 deadline — request MUST be replayed before this time |
| `memo` | `$.memo` | Opaque memo string to include in the toll transaction note |

**IF** `$.payment.asset.symbol` is NOT `"USDC"`, **THEN** abort — unsupported asset.
**IF** the current time exceeds `$.expires`, **THEN** abort — the 402 offer has expired. Re-request from Step 1.

---

## 3. Cryptographic Proof — The `X-PAYMENT` Header

### 3.1 Construct the Atomic Group

Build a **two-transaction atomic group** on Algorand:

**Transaction 0 — x402 Toll (ASA Transfer):**

| Field | Value |
|-------|-------|
| Type | `axfer` (Asset Transfer) |
| Sender | Your Algorand address (`senderAddress`) |
| Receiver | `payTo` from the 402 response |
| Amount | `amount` from the 402 response (integer, micro-USDC) |
| Asset ID | `asset_id` from the 402 response |
| Note | The `memo` string from the 402 response |

**Transaction 1 — Application Call (Bridge / Action):**

The second transaction depends on your intent. For cross-chain NTT bridging via Folks Finance, construct an application call with ABI arguments. IF you do not require bridging, you may omit this transaction and submit a single-transaction group.

**Assign the group ID** to all transactions using `algosdk.assignGroupID()`. This produces a SHA-512/256 hash binding them atomically.

### 3.2 Sign and Encode

1. Sign **every transaction** in the group with your Ed25519 private key (the key corresponding to `senderAddress`).
2. Produce an Ed25519 **signature over the raw `groupId` bytes**: `algosdk.signBytes(groupIdBytes, secretKey)`.
3. Construct the proof payload:

```json
{
  "groupId": "<BASE64_GROUP_ID_BYTES>",
  "transactions": ["<BASE64_SIGNED_TXN_0>", "<BASE64_SIGNED_TXN_1>"],
  "senderAddr": "<YOUR_ALGORAND_ADDRESS>",
  "signature": "<BASE64_ED25519_SIGNATURE_OVER_GROUP_ID>"
}
```

4. Base64-encode the entire JSON object.
5. Set the `X-PAYMENT` header to this Base64 string.

### 3.3 Replay the Request with Proof

```http
POST /api/agent-action HTTP/1.1
Content-Type: application/json
X-PAYMENT: <BASE64_ENCODED_PROOF_JSON>
X-SLIPPAGE-BIPS: 50

{
  "senderAddress": "<YOUR_ALGORAND_ADDRESS>",
  "amount": 100000,
  "destinationChain": "ethereum",
  "destinationRecipient": "<0x_ETH_ADDRESS>"
}
```

**Headers:**

| Header | Required | Type | Description |
|--------|----------|------|-------------|
| `X-PAYMENT` | YES | string (Base64) | Encoded proof payload (see 3.2) |
| `X-SLIPPAGE-BIPS` | NO | integer | Slippage tolerance in basis points. Default: `50` (0.5%). Maximum: `500` (5%). |

**Body fields:**

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `senderAddress` | YES | string | Your Algorand address |
| `amount` | NO | integer | Micro-USDC amount (defaults to protocol toll) |
| `destinationChain` | NO | string | Wormhole target chain (default: `"ethereum"`) |
| `destinationRecipient` | NO | string | Recipient on the destination chain |

**Expected response:** `HTTP 200 OK`

```json
{
  "status": "awaiting_signature",
  "export": {
    "sandboxId": "vk-sandbox-<UUID>",
    "sealedAt": "<ISO_8601>",
    "atomicGroup": {
      "transactions": ["<BASE64_UNSIGNED_TXN>", "..."],
      "groupId": "<BASE64_GROUP_HASH>",
      "manifest": ["[0] x402 Toll: 100000 microUSDC", "[1] NTT Bridge: ..."],
      "txnCount": 2
    },
    "routing": {
      "requiredSigner": "<SENDER_ADDRESS>",
      "tollReceiver": "<TREASURY_ADDRESS>",
      "bridgeDestination": "ethereum",
      "network": "algorand-testnet"
    },
    "slippage": {
      "toleranceBips": 50,
      "expectedAmount": "100000",
      "minAmountOut": "99500"
    }
  },
  "instructions": [
    "1. POST this export to /api/execute with your agentId to settle on-chain.",
    "2. Or route atomicGroup.transactions[] to Rocca Wallet manually."
  ]
}
```

**IF** the response status is `402`, **THEN** your `X-PAYMENT` proof was rejected. Check:
- Signature validity (Ed25519 over `groupId`).
- All transactions share the same `groupId`.
- The toll amount and receiver match the 402 terms.
- The 402 offer has not expired.

**IF** the response status is `400`, **THEN** check the error message for missing or malformed fields.

---

## 4. Execution Handoff — On-Chain Settlement

The `SandboxExport` returned from Step 3.3 is **inert** — it contains unsigned transaction blobs sealed inside a VibeKit sandbox. No on-chain activity has occurred yet.

To trigger Algorand atomic settlement, forward the export to the execution pipeline.

### 4.1 POST to `/api/execute`

```http
POST /api/execute HTTP/1.1
Content-Type: application/json

{
  "sandboxExport": { <ENTIRE_EXPORT_OBJECT_FROM_STEP_3> },
  "agentId": "<YOUR_UNIQUE_AGENT_IDENTIFIER>"
}
```

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `sandboxExport` | YES | object | The complete `export` object from the `/api/agent-action` 200 response |
| `agentId` | YES | string | A unique identifier for your agent (for audit trail) |

### 4.2 Pipeline Stages

The server executes a strict four-stage pipeline. IF any stage fails, the entire pipeline aborts — no partial settlement occurs.

```
Validation Gatekeeper → Liquid Auth (FIDO2) → Rocca Wallet (Sign) → Algorand Broadcast
```

### 4.3 Success Response (`HTTP 200`)

```json
{
  "success": true,
  "agentId": "<YOUR_AGENT_ID>",
  "sandboxId": "vk-sandbox-<UUID>",
  "settlement": {
    "confirmed": true,
    "confirmedRound": 12345,
    "txnId": "<ALGORAND_TXN_ID>",
    "groupId": "<BASE64_GROUP_ID>",
    "txnCount": 2,
    "settledAt": "<ISO_8601>"
  }
}
```

**IF** `$.success` is `true`, **THEN** the atomic group is confirmed on Algorand. The `txnId` is your on-chain receipt.

### 4.4 Failure Response (`HTTP 502`)

```json
{
  "error": "Settlement pipeline failed",
  "failedStage": "validation | auth | sign | broadcast",
  "detail": "<HUMAN_READABLE_ERROR>"
}
```

**Recovery logic by `failedStage`:**

| `failedStage` | Cause | Action |
|----------------|-------|--------|
| `validation` | Toll amount, receiver, or signer mismatch | Rebuild the atomic group from Step 1 |
| `auth` | FIDO2 challenge failed | Verify your agent identity and credentials |
| `sign` | Rocca Wallet refused to sign | Check Rocca API key and environment config |
| `broadcast` | Algorand node rejected the group | Check network status; retry after 10 seconds |

---

## 5. Complete Sequence Diagram

```
Agent                         x402 Server                    Algorand
  │                                │                            │
  ├─ POST /api/agent-action ──────►│                            │
  │  (no X-PAYMENT)                │                            │
  │◄─── 402 Payment Required ──────┤                            │
  │     (application/pay+json)     │                            │
  │                                │                            │
  │  [Build atomic group]          │                            │
  │  [Sign groupId with Ed25519]   │                            │
  │  [Encode X-PAYMENT header]     │                            │
  │                                │                            │
  ├─ POST /api/agent-action ──────►│                            │
  │  (X-PAYMENT: <proof>)          │                            │
  │◄─── 200 SandboxExport ────────┤                            │
  │                                │                            │
  ├─ POST /api/execute ───────────►│                            │
  │  (sandboxExport + agentId)     ├── Validate ──► Auth ──►   │
  │                                │   Sign ──► Broadcast ─────►│
  │                                │                   ◄── Confirm
  │◄─── 200 Settlement ───────────┤                            │
  │     (txnId, confirmedRound)    │                            │
```

---

## 6. Error Reference

| HTTP Status | Meaning | Agent Action |
|-------------|---------|-------------|
| `200` | Success | Parse response body and proceed |
| `400` | Bad Request — missing or malformed fields | Fix request body/headers and retry |
| `402` | Payment Required — no valid `X-PAYMENT` proof | Complete the x402 handshake (Section 2-3) |
| `500` | Internal Server Error | Retry after backoff; if persistent, abort |
| `502` | Pipeline stage failure | Check `failedStage` field (Section 4.4) |

---

## 7. JSON Schemas

### 7.1 `SandboxExport`

```typescript
interface SandboxExport {
  sandboxId: string;           // "vk-sandbox-<UUID>"
  sealedAt: string;            // ISO 8601
  atomicGroup: {
    transactions: string[];    // Base64 unsigned transaction blobs
    groupId: string;           // Base64 SHA-512/256 group hash
    manifest: string[];        // Human-readable transaction descriptions
    txnCount: number;          // Number of transactions in group
  };
  routing: {
    requiredSigner: string;    // Algorand address that must sign
    tollReceiver: string;      // Treasury address
    bridgeDestination: string; // "ethereum", "solana", etc.
    network: string;           // "algorand-testnet" or "algorand-mainnet"
  };
  slippage: {
    toleranceBips: number;     // 50 = 0.5%
    expectedAmount: string;    // Micro-units as string
    minAmountOut: string;      // Micro-units as string (floor)
  };
}
```

### 7.2 `X-PAYMENT` Decoded Payload

```typescript
interface XPaymentProof {
  groupId: string;             // Base64 group ID bytes
  transactions: string[];      // Base64 signed transaction blobs
  senderAddr: string;          // Algorand address (58-char Base32)
  signature: string;           // Base64 Ed25519 signature over groupId
}
```

### 7.3 `PayJson` (402 Response)

```typescript
interface PayJsonResponse {
  version: "x402-v1";
  status: 402;
  network: {
    protocol: "algorand";
    chain: "testnet" | "mainnet";
  };
  payment: {
    asset: {
      type: "ASA";
      id: number;              // Algorand Standard Asset ID
      symbol: "USDC";
      decimals: 6;
    };
    amount: string;            // Micro-units as string
    payTo: string;             // Treasury Algorand address
  };
  expires: string;             // ISO 8601 — 5-minute validity window
  memo: string;                // "x402:<endpoint>:<timestamp_ms>"
}
```

---

## 8. Constraints

- **Timeout:** The 402 offer expires in 5 minutes. Do not cache it beyond `$.expires`.
- **Slippage:** `X-SLIPPAGE-BIPS` must be an integer between `0` and `500`. Values above `500` are rejected.
- **Atomicity:** You cannot submit individual transactions. The group is all-or-nothing.
- **Idempotency:** Each `sandboxExport` has a unique `sandboxId`. Do not resubmit a settled export.
- **Network:** Always verify `$.network.chain` matches your configured Algorand node.
