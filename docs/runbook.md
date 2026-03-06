# Operations Runbook — algo-ai-agentic-wallet

> Keep this document updated as the system evolves.
> All commands assume you have Railway CLI (`railway`) and `redis-cli` available.

---

## 1. Halt the Signing Pipeline

The system has two halt mechanisms. Use the API path for normal operations; the Redis path is a break-glass option when the API is unreachable.

### Via API (normal path)

```bash
curl -X POST https://api.ai-agentic-wallet.com/api/system/halt \
  -H "Authorization: Bearer $PORTAL_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"reason": "manual halt — suspicious activity", "overrideKey": "$HALT_OVERRIDE_KEY"}'
```

Response: `{ "halted": true, "reason": "..." }`

All subsequent `/api/execute` requests will return `403 SYSTEM_HALTED` until cleared.

### Via Redis (break-glass)

```bash
redis-cli SET x402:halt '{"halted":true,"reason":"break-glass","haltedAt":"<ISO timestamp>"}'
```

The API reads this key on every execute request. No restart required.

---

## 2. Unhalt the Signing Pipeline

### Via API

```bash
curl -X POST https://api.ai-agentic-wallet.com/api/system/unhalt \
  -H "Authorization: Bearer $PORTAL_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"overrideKey": "$HALT_OVERRIDE_KEY"}'
```

Response: `{ "halted": false }`

### Via Redis (break-glass)

```bash
redis-cli DEL x402:halt
```

---

## 3. Rotate API Keys & Secrets

Generate fresh values before rotating:

```bash
openssl rand -hex 32   # 64-char hex secret
```

### Keys to rotate on Railway (main API service)

| Env var | Purpose | Action on rotation |
|---|---|---|
| `PORTAL_API_SECRET` | Portal ↔ API auth | Update Railway + Vercel portal `.env` simultaneously |
| `HALT_OVERRIDE_KEY` | Halt/unhalt guard | Update Railway only |
| `APPROVAL_TOKEN_SECRET` | Approval token HMAC | Update Railway only |
| `ROCCA_API_KEY` | Rocca wallet calls | Update Railway + signing service |
| `SIGNING_SERVICE_API_KEY` | Main API → signing service | Update both services |

### Rotating `PORTAL_API_SECRET`

1. Generate new value: `openssl rand -hex 32`
2. Set on Railway main API service
3. Set `NEXT_PUBLIC_API_SECRET` / `API_SECRET` on Vercel portal
4. Verify `/health` still returns `ok` after both redeploys

### Rotating `ALGO_MNEMONIC` (treasury wallet)

> **Warning:** This is the most sensitive rotation. Perform during low-traffic period.

1. Generate new wallet (air-gapped if possible): `npx tsx examples/gen-account.ts`
2. Fund new wallet with ≥ 0.5 ALGO
3. Opt new wallet into USDC: `ALGO_MNEMONIC=<new> npx tsx examples/usdc-optin.ts`
4. Update `ALGO_MNEMONIC` and `X402_PAY_TO_ADDRESS` on Railway
5. Re-register the Rocca cohort against the new signer address: `npx tsx scripts/rotate-signer.ts`
6. Reset the cross-region treasury hash in Redis:
   ```bash
   redis-cli DEL x402:treasury:cold-hash
   ```
   The next boot will re-anchor the new address.
7. Delete old agent registry entries if test agents remain:
   ```bash
   redis-cli --scan --pattern "x402:agent:*" | xargs redis-cli DEL
   ```

---

## 4. Recover from a Drain Event

Signs: Telegram alert fires `DRAIN_VELOCITY_HALT`, guardian sets `x402:halt`, mass-drain marker present.

### Step 1 — Confirm halt is active

```bash
curl https://api.ai-agentic-wallet.com/api/system/halt-status \
  -H "Authorization: Bearer $PORTAL_API_SECRET"
```

### Step 2 — Check drain details

```bash
curl https://api.ai-agentic-wallet.com/api/system/mass-drain \
  -H "Authorization: Bearer $PORTAL_API_SECRET"
```

Also check Redis directly:
```bash
redis-cli GET x402:guardian:drain
redis-cli GET x402:halt
```

### Step 3 — Investigate on-chain

Check signer wallet balance and recent transactions:
```
https://allo.info/address/<ALGO_SIGNER_ADDRESS>
```

Compare on-chain outflows vs authorized totals:
```bash
redis-cli GET x402:guardian:authorized:algo
redis-cli GET x402:guardian:authorized:usdc
```

### Step 4 — Resolve and clear

Once the incident is understood and resolved:

```bash
# Clear the mass-drain marker
curl -X POST https://api.ai-agentic-wallet.com/api/system/mass-drain/clear \
  -H "Authorization: Bearer $PORTAL_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"overrideKey": "$HALT_OVERRIDE_KEY"}'

# Unhalt the system
curl -X POST https://api.ai-agentic-wallet.com/api/system/unhalt \
  -H "Authorization: Bearer $PORTAL_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"overrideKey": "$HALT_OVERRIDE_KEY"}'
```

### Step 5 — Reset on-chain monitor counters

If a key rotation was performed, reset the Guardian counters so the new wallet starts fresh:
```bash
redis-cli SET x402:guardian:authorized:algo 0
redis-cli SET x402:guardian:authorized:usdc 0
redis-cli SET x402:onchain:last-round 0
redis-cli SET x402:onchain:algo-seen 0
redis-cli SET x402:onchain:usdc-seen 0
```

---

## 5. Recover from Redis Failure

If Redis becomes unavailable, the server will crash on boot (boot-time treasury hash check is fatal). This is intentional fail-closed behaviour.

### To restore

1. Confirm Redis is reachable: `redis-cli PING` → `PONG`
2. Redeploy the Railway main API service (it will re-bind Redis on boot)
3. Verify `/health` returns `"redis": true`

If the treasury hash key was lost from Redis, the next boot will re-anchor it automatically via `assertCrossRegionTreasuryHash()` (SET NX).

---

## 6. Deploy the Guardian Worker

The guardian runs as a separate Railway service using `Dockerfile.guardian`.

### First-time deploy

1. In Railway dashboard, create a new service in the same project
2. Set the Dockerfile path to `Dockerfile.guardian`
3. Set these env vars on the guardian service:
   - `UPSTASH_REDIS_REST_URL` — same as main API
   - `UPSTASH_REDIS_REST_TOKEN` — same as main API
   - `ALGORAND_NODE_URL` — mainnet Nodely endpoint
   - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — alert channel
   - `ALGO_SIGNER_ADDRESS` — address to monitor
   - `CHECK_INTERVAL_S=10`
4. Deploy

### Verify

Run a test alert locally first:
```bash
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
  npx tsx scripts/wallet-guardian.ts --test-alert
```

Confirm the Telegram message arrives before deploying to Railway.

---

## 7. Velocity Threshold Tuning

Default thresholds (set via Railway env vars):

| Env var | Default | Meaning |
|---|---|---|
| `VELOCITY_THRESHOLD_10M_MICROUSDC` | 50000000 | $50 per agent per 10 min |
| `VELOCITY_THRESHOLD_24H_MICROUSDC` | 500000000 | $500 per agent per 24h |

To temporarily lower the 10-min cap to $1 for testing:
```bash
railway variables set VELOCITY_THRESHOLD_10M_MICROUSDC=1000000
```

Restore after testing:
```bash
railway variables set VELOCITY_THRESHOLD_10M_MICROUSDC=50000000
```

---

## 8. Dedicated Signer Redis

The signing service shares the main Redis database by default. For production isolation (eliminates contention and clears the boot-time WARNING log), provision a separate Redis instance.

### Setup

1. In Railway dashboard, open the `rocca-signing-service` service
2. Click **+ New** → **Database** → **Redis**
3. Railway will inject `REDIS_URL` and `REDIS_PRIVATE_URL` — but since the signing service already uses those names for the main API's Redis, instead:
   - Go to the new Redis plugin → **Connect** → copy the private URL
   - Add it manually as `SIGNER_REDIS_PRIVATE_URL` on the signing service
4. Redeploy the signing service
5. Confirm the WARNING `"falling back to main API"` is gone from signing service logs

### Priority order (signerRedis.ts)
1. `SIGNER_REDIS_PRIVATE_URL` — Railway internal TCP (preferred)
2. `SIGNER_REDIS_URL` — Railway public URL
3. Falls back to shared main API Redis (generates WARNING)

---

## 9. Health Check Reference

```bash
curl https://api.ai-agentic-wallet.com/health
```

Expected healthy response:
```json
{
  "status": "ok",
  "apiVersion": "v1",
  "redis": true,
  "halted": false,
  "indexerOk": true,
  "node": { "latestRound": 12345678 }
}
```

Degraded states:
- `"status": "degraded"` — Nodely fallback active or indexer unreachable
- `"halted": true` — signing pipeline halted (check `x402:halt` in Redis)
- `"redis": false` — Redis unreachable (server will crash on next boot)

---

## 10. Monitoring Setup

### Railway CPU / Memory Alerts

1. Railway dashboard → your project → **Observability** → **Alerts**
2. Add alert: **CPU usage > 80%** → notify via email or Slack webhook
3. Add alert: **Memory usage > 80%** → same channel
4. Add alert: **Deploy failed** → same channel
5. Repeat for the `rocca-signing-service` and `guardian` services separately

### Uptime Monitor (UptimeRobot — free tier)

1. Sign up at [uptimerobot.com](https://uptimerobot.com)
2. **New Monitor** → HTTP(S) → URL: `https://api.ai-agentic-wallet.com/health`
3. Monitoring interval: **5 minutes**
4. Alert contacts: your email / Telegram
5. Set **Keyword** check: look for `"status":"ok"` to catch degraded state
6. Add a second monitor for the portal: `https://ai-agentic-wallet.com`

### Sentry

Sentry is already integrated in both the backend (`@sentry/node`) and portal (`@sentry/nextjs`).

- Dashboard: [sentry.io](https://sentry.io) → your project
- Review the **Issues** tab weekly for new error patterns
- Set up **Alert Rules**: notify on new issues with > 10 events/hour
- Key signals to watch:
  - `[Express] Unhandled error` — unexpected route failures
  - `[Boot] FATAL` — boot-time guard failures (should never happen in steady state)
  - `[execute]` errors — pipeline failures

### Nodely Latency Check

To check if Nodely free tier latency is acceptable:
```bash
time curl -s "https://mainnet-api.4160.nodely.dev/v2/status" | jq '.["last-round"]'
```

If p95 algod round-trip > 200ms, upgrade to Nodely paid tier:
```
https://nodely.io/pricing
```

Set `ALGORAND_NODE_URL` to your paid endpoint URL on Railway.
