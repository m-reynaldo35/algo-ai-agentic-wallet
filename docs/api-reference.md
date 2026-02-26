# x402 AI Agentic Wallet — Public API Reference

**Base URL:** `https://ai-agentic-wallet.com`
**Protocol:** x402-v1 on Algorand mainnet
**USDC Asset ID:** 31566704 (mainnet)

---

## Authentication

All management and settlement endpoints require a portal secret.
Pass it as either:

```
Authorization: Bearer <PORTAL_API_SECRET>
X-Portal-Key: <PORTAL_API_SECRET>
```

The `/api/agent-action` and `/api/batch-action` endpoints are gated by an
**x402 payment proof** (`X-PAYMENT` header) instead. The SDK handles the 402
handshake automatically — see the SDK templates for usage.

---

## Error envelope

All errors return a JSON body with at least an `error` field:

```json
{ "error": "DETERMINISTIC_CODE", "message": "Human-readable detail" }
```

---

## 1. Register Agent

**`POST /api/agents/register`**

Creates a new AI agent on Algorand mainnet. Generates an ephemeral keypair,
broadcasts a fund + USDC-optin + rekey atomic group, persists the registry
record, then discards the agent private key. Only the Rocca signing
infrastructure can authorize transactions from this address hereafter.

Registration is idempotent by `agentId` — a second call returns `409`.

**Auth:** `Authorization: Bearer <PORTAL_API_SECRET>`

**Rate limit:** Inherits platform limit (100 req / 10 s). Call once per agent lifetime.

### Request

```json
{
  "agentId":  "my-payment-agent-v1",
  "platform": "claude"
}
```

| Field     | Type   | Required | Constraints                                  |
|-----------|--------|----------|----------------------------------------------|
| `agentId` | string | yes      | 3–128 chars, `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` |
| `platform`| string | no       | ≤ 64 chars; e.g. `"openai"`, `"langgraph"`   |

### Response `201 Created`

```json
{
  "status":              "registered",
  "agentId":             "my-payment-agent-v1",
  "address":             "ABCXYZ7MOPQ...",
  "cohort":              "A",
  "authAddr":            "ROCCA_SIGNER_ADDR...",
  "registrationTxnId":   "TX3A7F...",
  "explorerUrl":         "https://allo.info/tx/TX3A7F...",
  "instructions": [
    "Agent my-payment-agent-v1 is rekeyed to Rocca signer.",
    "Fund the agent address with USDC to enable x402 payments."
  ]
}
```

### Errors

| HTTP | `error` value                       | Cause                               |
|------|-------------------------------------|-------------------------------------|
| 400  | `Missing required field: agentId`   | agentId absent or wrong type        |
| 400  | `Invalid agentId: <detail>`         | Fails character / length rules      |
| 401  | `Portal authentication required`    | No auth header                      |
| 403  | `Invalid portal credentials`        | Wrong secret                        |
| 409  | `Agent already registered: <id>`    | Duplicate agentId                   |
| 500  | `Agent registration failed`         | On-chain broadcast failed           |

---

## 2. Fund Agent (Off-Chain Step)

There is **no server endpoint** for funding. After registration, transfer USDC
(ASA 31566704) to the `address` returned from step 1 using any Algorand wallet
or SDK.

**ALGO for fees** is pre-funded during registration (0.5 ALGO). No additional
ALGO is needed for normal x402 toll payments.

**Recommended USDC balance** per default velocity policy:

| Window | Default ceiling | Minimum recommended balance |
|--------|-----------------|----------------------------|
| 10 min | $50 (50,000,000 µUSDC) | ≥ $50 USDC |
| 24 h   | $500 (500,000,000 µUSDC) | ≥ $500 USDC for sustained use |

Fund the address on-chain before submitting any transactions.

---

## 3. Submit Transaction

Submitting a USDC transaction is a **two-step flow**:

### Step 3a — Build atomic group

**`POST /api/agent-action`** (x402-gated)

Constructs the unsigned Algorand atomic group (USDC toll + optional bridge
transfer). Returns a sealed `sandboxExport` ready for execution.

This endpoint returns **HTTP 402** on the first call — the SDK absorbs the
bounce, signs a payment proof, and retries automatically. Do not call this
endpoint directly without the SDK.

**Auth:** `X-PAYMENT` header (x402 proof — built by SDK)

#### Request

```json
{
  "senderAddress":        "ABCXYZ7MOPQ...",
  "amount":               1000000,
  "destinationChain":     "ethereum",
  "destinationRecipient": "0xYourEthereumAddress"
}
```

| Field                  | Type   | Required | Notes                                    |
|------------------------|--------|----------|------------------------------------------|
| `senderAddress`        | string | yes      | Agent's Algorand address (58-char Base32)|
| `amount`               | number | no       | µUSDC; omit to use server default toll   |
| `destinationChain`     | string | no       | `ethereum` `solana` `base` `algorand`    |
| `destinationRecipient` | string | no       | Address on destination chain             |
| `X-SLIPPAGE-BIPS`      | header | no       | Integer; default 50 (0.5%), max 500      |

#### Response `200 OK`

```json
{
  "status": "awaiting_signature",
  "export": {
    "sandboxId":   "uuid-v4",
    "sealedAt":    "2024-01-01T00:00:00.000Z",
    "atomicGroup": {
      "transactions": ["base64-encoded-txn", "..."],
      "groupId":      "base64-group-id",
      "manifest":     ["Toll: 1.000 USDC → treasury", "Bridge: Algorand → Ethereum"],
      "txnCount":     2
    },
    "routing": {
      "requiredSigner":    "ABCXYZ7MOPQ...",
      "tollReceiver":      "TREASURY_ADDR...",
      "bridgeDestination": "0xYourEthereumAddress",
      "network":           "algorand-mainnet"
    },
    "slippage": {
      "toleranceBips": 50,
      "expectedAmount": "1000000",
      "minAmountOut":   "995000"
    }
  },
  "instructions": ["1. POST this export to /api/execute with your agentId."]
}
```

#### Error: `402 Payment Required` (x402 offer — SDK handles this)

```json
{
  "version": "x402-v1",
  "status":  402,
  "network": { "protocol": "algorand", "chain": "mainnet" },
  "payment": {
    "asset":  { "type": "ASA", "id": 31566704, "symbol": "USDC", "decimals": 6 },
    "amount": "1000000",
    "payTo":  "TREASURY_ADDR..."
  },
  "expires": "2024-01-01T00:05:00.000Z",
  "memo":    "x402:toll"
}
```

---

### Step 3b — Execute settlement

**`POST /api/execute`**

Runs the full settlement pipeline: validate → sign (Rocca) → broadcast →
confirm. Returns on-chain confirmation. **Idempotent** on `sandboxId` — safe
to retry on network timeout (24 h cache).

**Auth:** `Authorization: Bearer <PORTAL_API_SECRET>`

**Rate limits:**

| Scope         | Limit              | Response when exceeded |
|---------------|--------------------|------------------------|
| Agent burst   | 5 req / s          | `429 AGENT_BURST_LIMIT` |
| Agent sustained | 60 req / min     | `429 AGENT_RATE_LIMIT_EXCEEDED` |
| Global        | Platform-wide cap  | `503 GLOBAL_RATE_LIMIT_EXCEEDED` |

All 429 and 503 responses include `Retry-After: <seconds>`.

#### Request

```json
{
  "sandboxExport": { "...": "SandboxExport object from step 3a" },
  "agentId":       "my-payment-agent-v1"
}
```

| Field           | Type   | Required | Constraints              |
|-----------------|--------|----------|--------------------------|
| `sandboxExport` | object | yes      | Full SandboxExport from step 3a |
| `agentId`       | string | yes      | 3–128 chars              |

#### Response `200 OK` — settlement confirmed

```json
{
  "success":   true,
  "agentId":   "my-payment-agent-v1",
  "sandboxId": "uuid-v4",
  "settlement": {
    "confirmed":      true,
    "confirmedRound": 38291847,
    "txnId":          "TXABC123...",
    "groupId":        "GRPABC123...",
    "txnCount":       2,
    "settledAt":      "2024-01-01T00:00:01.123Z"
  }
}
```

#### Errors

| HTTP | `error` value                    | Cause                                         |
|------|----------------------------------|-----------------------------------------------|
| 400  | `Missing required fields: ...`   | sandboxExport or agentId absent               |
| 400  | `agentId must be a string ...`   | agentId fails length check                    |
| 402  | `VELOCITY_APPROVAL_REQUIRED`     | Spend exceeds sliding-window threshold        |
| 429  | `AGENT_BURST_LIMIT`              | Burst quota exceeded; check Retry-After       |
| 429  | `AGENT_RATE_LIMIT_EXCEEDED`      | Sustained quota exceeded; check Retry-After   |
| 503  | `SIGNER_CIRCUIT_OPEN`            | Signing service degraded; transient           |
| 503  | `GLOBAL_RATE_LIMIT_EXCEEDED`     | Global quota; check Retry-After               |
| 502  | `Settlement pipeline failed`     | On-chain broadcast/signing failed             |

#### Velocity block response `402`

When the agent's rolling spend would exceed its configured window ceiling, the
transaction is blocked and the current window state is returned:

```json
{
  "error":              "VELOCITY_APPROVAL_REQUIRED",
  "message":            "Spend velocity exceeds threshold — submit a Tier 1 approval token",
  "tenMinTotal":        "45000000",
  "dayTotal":           "380000000",
  "threshold10m":       "50000000",
  "threshold24h":       "500000000",
  "proposedMicroUsdc":  "8000000"
}
```

All amounts are in **micro-USDC** (1 USDC = 1,000,000 µUSDC). Divide by 1e6
for display.

---

## 4. Check Status

**`GET /api/agents/:agentId`**

Returns the agent's registry record: on-chain address, custody status,
auth-addr, and operational status.

**Auth:** `Authorization: Bearer <PORTAL_API_SECRET>`

### Response `200 OK`

```json
{
  "agentId":            "my-payment-agent-v1",
  "address":            "ABCXYZ7MOPQ...",
  "cohort":             "A",
  "authAddr":           "ROCCA_SIGNER_ADDR...",
  "status":             "active",
  "platform":           "claude",
  "custody":            "rocca",
  "custodyVersion":     1,
  "createdAt":          "2024-01-01T00:00:00.000Z",
  "registrationTxnId":  "TX3A7F..."
}
```

**`status` values:**

| Value        | Signing allowed | Cause                                       |
|--------------|-----------------|---------------------------------------------|
| `registered` | yes             | Registration confirmed; not yet funded      |
| `active`     | yes             | Fully operational                           |
| `suspended`  | **no**          | Manually suspended by operator              |
| `orphaned`   | **no**          | DriftPulse detected auth-addr mismatch on-chain |

Agents in `suspended` or `orphaned` status will have transactions rejected
at the signing service level.

### Errors

| HTTP | `error` value                 | Cause                      |
|------|-------------------------------|----------------------------|
| 404  | `Agent not found: <id>`       | agentId not in registry    |
| 401  | `Portal authentication required` | Missing auth header     |
| 403  | `Invalid portal credentials`  | Wrong secret               |

---

## 5. Policy

**`GET /api/portal/config`**

Returns the server's rate limit and network configuration.

**Auth:** `Authorization: Bearer <PORTAL_API_SECRET>`

### Response `200 OK`

```json
{
  "network":    "algorand-mainnet",
  "serverUrl":  "https://ai-agentic-wallet.com",
  "rateLimits": {
    "ipMax":          30,
    "ipWindow":       "10s",
    "platformMax":    100,
    "platformWindow": "10s"
  }
}
```

Velocity thresholds (per-agent USDC spend windows) are server-side policy
configured via environment variables. Their current values are returned inline
when `/api/execute` returns `402 VELOCITY_APPROVAL_REQUIRED` (see section 3b).

**Default velocity policy:**

| Window | Ceiling | Env var |
|--------|---------|---------|
| 10 min | $50 USDC (50,000,000 µUSDC) | `VELOCITY_THRESHOLD_10M_MICROUSDC` |
| 24 h   | $500 USDC (500,000,000 µUSDC) | `VELOCITY_THRESHOLD_24H_MICROUSDC` |

---

## 6. Velocity Status

There is no dedicated velocity-status endpoint. Velocity state is **returned
inline** when `/api/execute` returns `402 VELOCITY_APPROVAL_REQUIRED`.

The response body contains the agent's current window totals, the policy
ceilings, and the proposed spend that triggered the block (see section 3b).

**Proactive tracking:** Agents that want to avoid velocity blocks before
submission should track their own cumulative spend from `settlement.settledAt`
timestamps and `proposedMicroUsdc` from prior executions, compared against the
`threshold10m` / `threshold24h` values last received in a velocity response.

---

## Idempotency

`/api/execute` is idempotent on `sandboxId`. If a network timeout causes a
retry, the second call returns the cached result with the header:

```
X-Idempotent-Replay: true
```

The cache TTL is 24 hours. Do not reuse a `sandboxId` for a different
transaction.

---

## Deterministic Failure Codes

| Code                         | HTTP | Retryable | Action                                      |
|------------------------------|------|-----------|---------------------------------------------|
| `AGENT_BURST_LIMIT`          | 429  | yes       | Wait `Retry-After` seconds                  |
| `AGENT_RATE_LIMIT_EXCEEDED`  | 429  | yes       | Wait `Retry-After` seconds                  |
| `GLOBAL_RATE_LIMIT_EXCEEDED` | 503  | yes       | Wait `Retry-After` seconds                  |
| `SIGNER_CIRCUIT_OPEN`        | 503  | yes       | Signing service degraded; retry in ~30s     |
| `VELOCITY_APPROVAL_REQUIRED` | 402  | no        | Request approval token or wait for window reset |
| `Settlement pipeline failed` | 502  | sometimes | Check `failedStage`; sign/broadcast failures are transient |
| `Agent already registered`   | 409  | no        | Duplicate agentId; skip registration        |

---

## Health

**`GET /health`** — No auth required

```json
{
  "status":   "ok",
  "protocol": "x402",
  "network":  "algorand-mainnet",
  "node": {
    "provider":    "nodely",
    "algod":       "https://...",
    "latestRound": 38291847
  }
}
```

`status` is `"ok"` or `"degraded"` (Algorand node unreachable).
