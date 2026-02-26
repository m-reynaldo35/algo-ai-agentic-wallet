# Operational Safety Model — Phase 1.5 Hardening

This document describes the lightweight protection layer added to the Rocca
Algorand signing system. All protections are implemented in `src/protection/`
and integrated into the `/api/execute` pipeline.

---

## Architecture

```
POST /api/execute
       │
       ├─ requirePortalAuth          (existing — bearer token gate)
       ├─ schema validation           (existing — agentId, sandboxExport)
       │
       ├─ isCircuitOpen()            ← NEW: 503 if signer is degraded
       ├─ checkExecutionLimits()     ← NEW: 429/503 per-agent + global
       │
       ├─ idempotency check          (existing — Redis sandboxId cache)
       ├─ executePipeline()          (existing — sign + broadcast)
       │
       ├─ recordSuccess()            ← NEW: resets circuit state
       └─ recordFailure()            ← NEW: increments circuit counter
```

No queues, no background workers, no architectural changes.
The protection layer is a pure request-time gate.

---

## Protection Layers

### 1. Per-Agent Burst Guard (Section 4)

Prevents a runaway agent from firing requests faster than the signer can
process them, even if the 60-second window has headroom.

| Property    | Value             |
|-------------|-------------------|
| Redis key   | `burst:agent:{publicAddress}` |
| Limit       | 5 tx per 10 seconds |
| Algorithm   | Sliding window (ZSET) |
| Rejection   | HTTP 429, `AGENT_BURST_LIMIT` |

### 2. Per-Agent Rate Limit (Section 2)

Sustained rate cap per agent over a rolling 60-second window.

| Property    | Value             |
|-------------|-------------------|
| Redis key   | `rate:agent:{publicAddress}` |
| Limit       | 20 tx per 60 seconds |
| Algorithm   | Sliding window (ZSET) |
| Rejection   | HTTP 429, `AGENT_RATE_LIMIT_EXCEEDED` |

### 3. Global Signer Rate Limit (Section 3)

Protects the master signer from aggregate overload regardless of how many
agents are active simultaneously. Protects against Railway autoscaling
amplification — more instances = same global limit.

| Property    | Value             |
|-------------|-------------------|
| Redis key   | `rate:global:signer` |
| Limit       | 200 tx per 60 seconds |
| Algorithm   | Sliding window (ZSET) |
| Rejection   | HTTP 503, `GLOBAL_RATE_LIMIT_EXCEEDED` |

### 4. Signer Circuit Breaker (Section 5)

Protects against RPC failure loops. If signing or broadcasting fails
10 times within 60 seconds, the circuit opens and blocks all signing
for 60 seconds. A single successful submission resets all state.

Only Stage 3 (sign) and Stage 4 (broadcast) failures feed the breaker.
Auth, validation, and rate limit rejections do not count — they indicate
client errors, not RPC instability.

| Property       | Value             |
|----------------|-------------------|
| Failure key    | `circuit:signer:failures` (INCR, TTL 60s) |
| Open flag key  | `circuit:signer:open` (SET, TTL 60s) |
| Threshold      | 10 failures in 60 seconds |
| Cooldown       | 60 seconds |
| Rejection      | HTTP 503, `SIGNER_CIRCUIT_OPEN` |
| Reset          | Any successful submission |

---

## Sliding Window Implementation

All limits use Redis sorted sets (ZSET) — not the `@upstash/ratelimit` library.

```
ZREMRANGEBYSCORE key 0 (now - windowMs)   ← prune expired entries
ZCARD key                                  ← count active entries
if count >= max → reject (do NOT ZADD)    ← rejected requests don't consume quota
ZADD key score=now member="{ts}:{random}" ← record accepted request
EXPIRE key windowSeconds+1                ← keep key alive
```

Members use `{timestamp}:{random}` to guarantee uniqueness even when
two requests arrive within the same millisecond.

**Rejection behaviour:** requests that hit the limit are NOT added to the
sorted set. A burst of 100 rejected requests does not advance the window
start — the window resets naturally as accepted entries age out.

---

## Redis Key Schema

```
burst:agent:{publicAddress}      ZSET   Burst guard entries       TTL: 11s
rate:agent:{publicAddress}       ZSET   Per-agent entries         TTL: 61s
rate:global:signer               ZSET   Global entries            TTL: 61s
circuit:signer:failures          STRING INCR failure counter      TTL: 60s
circuit:signer:open              STRING Circuit open flag         TTL: 60s
x402:rejection-log               ZSET   Rejection event log       no TTL, 1000 entries max
x402:idempotent:{sandboxId}      STRING Pipeline result cache     TTL: 24h (existing)
x402:mock-token:{token}          STRING Mock auth token           TTL: 300s (existing)
x402:signing-replay:{requestId}  STRING Signing nonce            TTL: 300s (existing)
```

---

## Environment Variables

### Required in production (boot fails if missing)

| Variable                    | Section | Purpose |
|-----------------------------|---------|---------|
| `UPSTASH_REDIS_REST_URL`    | 1       | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN`  | 1       | Upstash Redis REST auth token |
| `X402_PAY_TO_ADDRESS`       | 7       | Treasury Algorand address (frozen at boot) |

### Security guards

| Variable                 | Section | Behaviour |
|--------------------------|---------|-----------|
| `DEV_SIGNER_ALLOWED`     | 8       | Set to `true` to allow `ALGO_SIGNER_MNEMONIC` outside production |
| `RAILWAY_ENVIRONMENT`    | 8       | Injected by Railway. Guard checks this alongside `NODE_ENV` — signing service has `NODE_ENV=undefined`, so `RAILWAY_ENVIRONMENT=production` is the authoritative prod check. Any other value (e.g. `pr-123`, `staging`) causes the guard to throw if the mnemonic is present. |
| `IP_HASH_SALT`           | —       | Secret salt for IP address hashing in rejection logs. SHA-256(ip + salt) prevents offline rainbow table attacks against the full IPv4 address space. Generate with `openssl rand -base64 32`. Must be identical across all instances of the same service. Never rotate casually — rotation breaks log correlation for the window between deployments. Never logged. |
| `APPROVAL_TOKEN_SECRET`  | —       | HMAC-SHA256 signing key for Tier 1 approval tokens. Minimum 32 characters. Generate with `openssl rand -hex 32`. Must be the same across all instances. Rotation invalidates all in-flight approval tokens (60s TTL means impact is minimal). Never logged. If not set, `issueApprovalToken` throws — Tier 1 approval flow requires this to be set before enabling. |

### Tunable limits (all have safe defaults)

| Variable                 | Default | Description |
|--------------------------|---------|-------------|
| `EXEC_BURST_MAX`         | 5       | Max tx per burst window |
| `EXEC_BURST_WIN_S`       | 10      | Burst window seconds |
| `EXEC_AGENT_MAX`         | 20      | Max tx per agent per minute window |
| `EXEC_AGENT_WIN_S`       | 60      | Per-agent window seconds |
| `EXEC_GLOBAL_MAX`        | 200     | Max tx across all agents per minute |
| `EXEC_GLOBAL_WIN_S`      | 60      | Global window seconds |
| `CIRCUIT_FAILURE_MAX`    | 10      | Failures before circuit opens |
| `CIRCUIT_WINDOW_S`       | 60      | Failure measurement window |
| `CIRCUIT_COOLDOWN_S`     | 60      | How long circuit stays open |

---

## Failure Modes

| Component          | Redis unavailable | Behaviour |
|--------------------|-------------------|-----------|
| Execution limiter  | Fail **open**     | Limits skipped, warning logged |
| Circuit breaker    | Fail **closed**   | Circuit never trips, requests allowed |
| Rejection logger   | Graceful          | stdout logging still works; Redis write silently skipped |
| Boot guard (prod)  | **Hard fail**     | Process refuses to start |

The asymmetry is intentional: a Redis outage should never silently disable
protection AND block production traffic simultaneously. The circuit breaker
failing closed means signing can continue even if Redis goes down — but the
logging will reveal the outage.

---

## Structured Rejection Events

Every rejection writes a structured JSON event to stdout and to the Redis
ring buffer (`x402:rejection-log`, last 1000 entries):

```json
{
  "type": "BURST_LIMIT | RATE_LIMIT | GLOBAL_LIMIT | CIRCUIT_OPEN",
  "agent": "ALGO_ADDRESS_OR_AGENT_ID",
  "timestamp": "2026-02-22T09:00:00.000Z",
  "ip_hash": "a1b2c3d4e5f6a7b8",
  "reason_code": "AGENT_BURST_LIMIT"
}
```

**Never logged:** transaction blobs, auth tokens, signatures, private keys,
or full IP addresses. IPs are SHA-256 hashed (first 16 hex chars) — enough
for correlation, not enough to reconstruct the source.

---

## Boot Sequence

```
1. initSentry()                     ← error reporting (existing)
2. runBootGuards()                  ← Phase 1.5 env validation (NEW)
   ├─ assertRedisCredentials()      ← UPSTASH vars required in production
   ├─ assertAndFreezeTreasury()     ← X402_PAY_TO_ADDRESS required; config frozen
   └─ assertSignerEnvironment()     ← mnemonic refused outside production
3. assertProductionAuthReady()      ← LIQUID_AUTH_SERVER_URL required in production
4. app.listen()                     ← start accepting traffic
```

Any boot guard failure throws — the process exits before binding a port.
Railway will surface this as a deployment failure with a clear error message.

---

## Emergency Procedures

### Manually open the circuit breaker

To immediately block all signing (e.g. during a security incident):

```bash
# Via Upstash console or Redis CLI:
SET circuit:signer:open 1 EX 3600   # Block for 1 hour
```

All `/api/execute` calls will return 503 `SIGNER_CIRCUIT_OPEN` until the key expires
or is deleted.

### Manually close the circuit breaker

```bash
DEL circuit:signer:open
DEL circuit:signer:failures
```

### Clear rate limits for a specific agent

```bash
DEL "rate:agent:{publicAddress}"
DEL "burst:agent:{publicAddress}"
```

### View recent rejections

```bash
# Last 20 rejection events (sorted by time, newest last):
ZRANGE x402:rejection-log -20 -1
```

### Adjust limits without redeploying

All tunable limits are environment variables. Update them in Railway and
redeploy — the new values take effect at the next boot without code changes.

---

## What This Does NOT Cover

- Queuing or backpressure (out of scope)
- Per-route limits on other endpoints (only `/api/execute` is protected)
- DDoS at the network layer (use Railway's edge / Cloudflare for that)
- Key compromise (handled by the existing rekey rotation system)
- FIDO2 / Liquid Auth bypass (handled by the existing auth layer)
