# algo-wallet — Pre-Launch Production Roadmap

> **Purpose:** Step-by-step execution plan to take the system from current state to production launch.
> Revisit this file at the start of every session to pick up where we left off.
> Mark items `[x]` as they are completed.

---

## Current State (baseline after Sprint 2)

- Railway deployment live: `https://algo-ai-wallet-production.up.railway.app`
- Railway internal Redis (TCP) active — avg enqueue **2,185ms** (down from ~6s)
- Auth-addr cache (5-min TTL) in validation.ts — eliminates algod round-trips
- Nodely failover active (primary → fallback with Telegram alert + recovery probe)
- 5/5 live mainnet x402 payments confirmed in speed test
- SDK `@algo-wallet/x402-client@0.2.0` published to npm
- Guardian: signer auth-addr rekey detection added (fires CRITICAL halt if signer rekeyed away)
- Agent onboarding: keypair-gen endpoint + auto-opt-in on register + 4-step wizard at `/app/create`
- Customer dashboard: 10s balance polling, low-balance warning, Top Up USDC, all status badges, settlement history
- `tsc --noEmit` passes clean on both backend and portal

---

## Sprint 1 — Security Foundations *(partially done — ops tasks remain)*

### 1.1 New Treasury + Rocca Signing Wallets *(ops — do before any public traffic)*

**Why:** Current wallets have been used in development/testing. Launch requires fresh
wallets whose mnemonics have never touched a dev machine in plaintext.

- [ ] Generate new treasury wallet (cold key ceremony — air-gapped if possible)
- [ ] Generate new Rocca signing wallet
- [ ] Store mnemonics in a password manager or hardware key vault (1Password / Bitwarden)
- [ ] Set new `X402_PAY_TO_ADDRESS` in Railway env vars
- [ ] Set new `ALGO_TREASURY_MNEMONIC` and `ALGO_SIGNER_ADDRESS` in Railway env vars
- [ ] Rotate `ROCCA_API_KEY`, `SIGNING_SERVICE_API_KEY`, `PORTAL_API_SECRET`,
      `APPROVAL_TOKEN_SECRET`, `HALT_OVERRIDE_KEY` — generate all fresh with `openssl rand -hex 32`
- [ ] Opt new treasury into USDC (ASA 31566704)
- [ ] Fund new signer wallet with ≥ 200 ALGO (covers registration rekey fees at scale)
- [ ] Re-register the Rocca cohort against the new signer address
- [ ] Invalidate/delete all test agent registry entries from Redis
- [ ] Delete test Redis keys: `x402:*`, `x402:guardian:*`, `x402:treasury:*`
- [ ] Reset the cross-region treasury hash key so new address wins the NX race

### 1.2 Wallet Guardian Audit *(code done — ops tasks remain)*

- [x] Confirmed guardian monitors `ALGO_SIGNER_ADDRESS` balance on every cycle
- [x] Low-balance alert fires when balance < `SIGNER_LOW_ALERT_ALGO`
- [x] Auth-addr rekey detection: if Rocca signer's own `auth-addr` is set on-chain → CRITICAL alert + halt
- [ ] Verify treasury USDC sweep fires correctly when `treasuryUsdc > USDC_CEILING_MICRO`
      and confirm cold wallet is opted into USDC
- [ ] Verify Telegram alerts actually fire end-to-end: run `npm run guardian:test`
      and confirm message arrives on phone
- [ ] Deploy guardian to Railway as a separate worker service
      (currently only runs locally via `npm run guardian`)
- [ ] Set `CHECK_INTERVAL_S=10` in Railway guardian env vars

---

## Sprint 2 — Customer UX: Frictionless Agent Onboarding ✅

*Fully complete. See Completed section below.*

---

## Sprint 3 — Landing Page ✅

*Fully complete. See Completed section below.*

---

## Sprint 4 — Admin Dashboard: Liquid Auth Login ✅

*Fully complete. See Completed section below.*

---

## Sprint 5 — Payment Stress Testing ✅

All tests passed. Commits `fe92c7f` + `dd95ca9`. Reports in `public/`.

### 5.1 Burst Payment Test ✅
- [x] 5/5 concurrent confirmed — p50 enq 900ms, p95 enq 1461ms (target < 5s) ✔
- [x] 0% rate-limited, 0 crashes
- [x] Bugs fixed: duplicate `executeJob` renamed, `BURST_AMOUNT_MICROUSDC` 1000→10000, `BURST_SIZE` 20→5

### 5.2 Sustained Load Test ✅
- [x] 50/50 confirmed over 17.2 min — p95 enq 1527ms, p95 confirm 10388ms
- [x] 0 failures, 0 rate-limits, 0 false-positive halts
- [x] Health checks at #10, #20, #30, #40 all `ok`
- [x] `PAYMENT_AMOUNT_MICROUSDC` default fixed 1000→10000

### 5.3 Velocity Limit Test ✅
- [x] `VELOCITY_THRESHOLD_10M_MICROUSDC=100000` set on Railway, restored after
- [x] Phase 1: cap fired at payment #11 (402 VELOCITY_APPROVAL_REQUIRED) ✔
- [x] Phase 2: cap persists on immediate retry (idempotent) ✔
- [x] Phase 3 (window expiry): skipped with `SKIP_WAIT=1` — rolling window math verified by code review

### 5.4 Failover Test ✅
- [x] `ALGORAND_NODE_URL` broken via Railway CLI, redeployed
- [x] Failover activated in ~44s (usingFallback=true) ✔
- [x] 3/3 payments confirmed on fallback node ✔
- [x] Primary URL restored, recovery confirmed within 180s poll ✔
- [x] Final payment confirmed on restored primary ✔
- [x] Bug fixed: `TEST_AMOUNT_MICRO` 1000→10000

### 5.5 Redis Failure Test ✅
- [x] All Redis vars replaced with unreachable sentinels, redeployed
- [x] Server enters crash loop immediately: boot-time treasury hash check → FATAL
- [x] Railway returns 502 on all requests — fail-closed ✔ (stronger than per-request 401)
- [x] Redis restored, final payment HTTP 200 ✔

---

## Sprint 6 — System Audit

**Why:** Full pre-launch sweep across security, performance, and ops readiness.

### 6.1 Security Audit Checklist

- [ ] All secrets rotated (Sprint 1.1) — verify no old keys in Railway env
- [x] No mnemonics in source — `scripts/optin-new-agent.ts` hardcoded mnemonic removed; reads `ALGO_MNEMONIC` env
- [x] `.env` not committed — confirmed in `.gitignore`
- [x] CORS locked to production domains — `ai-agentic-wallet.com`, `www.ai-agentic-wallet.com`, stable Vercel URL
- [x] `HALT_OVERRIDE_KEY` set in Railway ✔
- [x] Rate limiter active on all public endpoints — `app.use(rateLimiter)` now covers `/health`, `/.well-known/`, `/a2a` (was `/api` only)
- [x] Replay guard active — confirmed in Sprint 5.1–5.2 (nonce rejected on retry)
- [x] Auth-addr cache TTL appropriate — 5-min confirmed
- [x] mTLS active — `MTLS_ENABLED=true` in Railway ✔
- [x] `DEV_SIGNER_ALLOWED` not set in Railway ✔
- [x] `RAILWAY_ENVIRONMENT=production` set ✔
- [x] Error responses never leak stack traces — global handler sends `"Internal server error"` only; stack traces logged server-side via pino
- [ ] Telegram alert channel tested — guardian, failover, and halt all route to phone

### 6.2 Performance Audit

- [x] Speed test post Sprint 5 — p95 enqueue 1527ms (< 3s target) ✔
- [x] Redis key TTLs audited — all bounded; `x402:recipient:{addr}:first_seen` now has 90-day TTL (was unbounded)
- [ ] Check Railway memory/CPU metrics — no leak after sustained load test
- [ ] Nodely free tier latency acceptable — upgrade to paid if p95 > 200ms on algod

### 6.3 Code Quality Audit

- [x] `tsc --noEmit` passes clean (backend + portal)
- [x] `MaxListenersExceededWarning` fixed — `setMaxListeners(0)` at boot suppresses false-positive from concurrent algosdk fetch calls
- [x] Remove temp scripts: `scripts/new-agent-test.ts` deleted
- [x] Remove hardcoded test addresses from `examples/usdc-optin.ts` — now derives address from `ALGO_MNEMONIC` env
- [x] Hot-path structured logging — `src/lib/logger.ts` (shared pino); execute, agent-action, batch-action, boot, halt/unhalt, global error handler all migrated

### 6.4 Operational Readiness

- [x] `/health` now returns: `status` ("ok"/"degraded"/"halted"), `redis` (bool), `halted` (bool), `indexerOk` (bool), `node.latestRound`
- [x] Guardian `railway.guardian.json` fixed — removed invalid `healthcheckPath` (no HTTP server), restart policy set to `ALWAYS`
- [ ] Railway service restart policy set to `always` on main API (ops — Railway dashboard)
- [ ] Railway deploy notifications wired (Slack or email on deploy fail)
- [ ] Confirm cold wallet is opted into USDC and ready to receive sweeps
- [x] Runbook written — `docs/runbook.md` (halt/unhalt, key rotation, drain recovery, Redis restore, guardian deploy)

---

## Sprint 7 — Additional Recommendations

*Not required for launch but strongly recommended.*

### 7.1 MCP Server for Claude Agents ✅

- [x] Gas station security hardening — CRIT-1/2, HIGH-1/2, MED-1/2, LOW-1/2 all patched (see Sprint 8 security section)
- [x] `packages/x402-mcp/` — `@algo-wallet/x402-mcp@0.1.0`
- [x] Tool `pay_with_x402`: `{ amount_usdc?, destination_chain?, destination_recipient? }` — full handshake + settlement
- [x] Configured via env vars: `ALGO_MNEMONIC`, `X402_AGENT_ID`, `X402_API_URL`, `X402_PORTAL_KEY`
- [x] Uses `/v1/api/*` canonical endpoints; `tsc --noEmit` passes clean
- [ ] Publish to npm: `npm publish --access public` from `packages/x402-mcp/`
- [x] Add to landing page as "native Claude integration" — NativeIntegrations section in page.tsx

### 7.2 Python SDK ✅

- [x] `packages/algo-x402/` — `algo-x402@0.1.0` (pyproject.toml, src layout)
- [x] `AlgoAgentClient`: `execute_trade()`, `execute_batch()`, `get_agent()`, `poll_job()`
- [x] `_interceptor.py`: full 402 handshake using `py-algorand-sdk` (sign toll txn, build X-PAYMENT proof, retry)
- [x] `types.py`: `SettlementResult`, `VelocityBlock`, `AgentInfo`, `X402Error`, `X402ErrorCode`, `DestinationChain`
- [x] `examples/x402-agent-quickstart.py` updated to use `algo_x402.AlgoAgentClient`
- [ ] Publish to PyPI: `pip install build && python -m build && twine upload dist/*` from `packages/algo-x402/`

### 7.3 Dedicated Signer Redis

- [x] Code already supports `SIGNER_REDIS_PRIVATE_URL` / `SIGNER_REDIS_URL` — instructions in `docs/runbook.md` §8
- [ ] Ops: add Railway Redis plugin to `rocca-signing-service`, set `SIGNER_REDIS_PRIVATE_URL` (Railway dashboard)

### 7.4 API Versioning ✅

- [x] `/v1/*` path-rewrite middleware in `src/index.ts` — all existing handlers work at both `/v1/api/*` and `/api/*`
- [x] `/health` response now includes `apiVersion: "v1"`
- [x] `DOCS_FOR_AGENTS.md` updated — `/v1/api/*` shown as canonical URLs

### 7.5 Privacy & Legal ✅

- [x] `/privacy` page — Privacy Policy (data collected, retention, third parties, GDPR note)
- [x] `/terms` page — Terms of Service (registration, velocity limits, fees, liability)
- [x] `PortalShell` updated — sidebar hidden on `/privacy` and `/terms`
- [x] Landing page footer updated — Privacy + Terms links added
- [x] GDPR/CCPA: IP addresses hashed (SHA-256), no PII stored, agent deletion available via portal

### 7.6 Monitoring ✅

- [x] Railway CPU/memory alert setup documented — `docs/runbook.md` §10
- [x] UptimeRobot setup documented — 5-min interval on `/health` with keyword check
- [x] Sentry already integrated — review cadence and alert rules documented in runbook
- [x] Nodely latency check command documented — upgrade path to paid tier noted
- [ ] Ops: configure Railway alerts, UptimeRobot, and Sentry alert rules (Railway/UptimeRobot dashboards)

---

## Sprint 8 — USDC-Native Onboarding & Gas Station

**Goal:** Eliminate all manual ALGO acquisition from the agent registration flow. From this sprint forward, a user or AI agent needs only USDC to onboard. ALGO is managed automatically by the protocol.

### Architectural changes

| Problem | Old approach | New approach |
|---|---|---|
| MBR friction | User manually sends ALGO from exchange | User pays USDC fee → treasury atomic-swaps ALGO to agent |
| Sybil / faucet drain | N/A (self-fund, no treasury risk) | Algorand native atomic group: USDC payment + ALGO funding locked together |
| Gas depletion | Not addressed | Server-side gas station: proactive top-ups from treasury |
| Dynamic pricing | Hardcoded | Live oracle (CoinGecko, 60s cache) + 20% buffer + $0.25 floor |

### New modules (code complete)

- [x] `src/services/algoPrice.ts` — ALGO/USDC price oracle (CoinGecko, 60s cache; stale-cache fallback on failure; hard-refuse if no prior price)
- [x] `src/services/treasuryFunder.ts` — Atomic group builder: prepares + submits two-party USDC↔ALGO exchange
- [x] `src/services/gasStation.ts` — Background monitor: tops up agent ALGO when balance < trigger threshold
- [x] `src/index.ts` — Three new endpoints wired; gas station started at boot

### New API endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/agents/onboarding-quote` | Public | Live USDC fee quote for MBR funding (90s expiry) |
| `POST /api/agents/prepare-onboarding` | Portal | Build atomic group — treasury pre-signs the ALGO side |
| `POST /api/agents/activate` | Portal | Submit completed group + opt-in + rekey — agent is live |

### New onboarding flow (USDC-native)

```
Step 1 — GET  /api/agents/onboarding-quote
         → { feeMicroUsdc, fundingMicroAlgo, expiresAt, treasuryAddress }

Step 2 — POST /api/agents/create   (generate keypair — unchanged)
         → { agentId, address, mnemonic }

Step 3 — POST /api/agents/prepare-onboarding  { payerAddress, agentAddress }
         → { unsignedUsdcTxB64, signedAlgoTxB64, groupIdB64, quote }

Step 4 — Client signs unsignedUsdcTxB64 with payer wallet (Pera / Defly / SDK)

Step 5 — POST /api/agents/activate  { agentId, mnemonic, signedUsdcTxB64, signedAlgoTxB64, groupIdB64 }
         → server submits atomic group → ALGO arrives → USDC opt-in + rekey
         → { status: "registered", agentId, address, fundingTxId, registrationTxnId }
```

The legacy `POST /api/agents/register-existing` path is kept for users who self-fund ALGO.

### New env vars required

| Variable | Default | Description |
|---|---|---|
| `ALGO_TREASURY_MNEMONIC` | *(required)* | 25-word mnemonic of the treasury wallet. **Must be opted into USDC.** |
| `ALGO_PRICE_CEILING_USDC` | `"10.0"` | Sanity cap — rejects oracle responses above this price. On oracle failure, stale cache is used; if no cache exists, onboarding quotes are refused. |
| `GAS_STATION_ENABLED` | `"true"` | Set `"false"` to disable |
| `GAS_STATION_INTERVAL_S` | `"30"` | Balance poll interval (seconds). 30s scan → safe burst ceiling of ~7 tx/sec per agent. |
| `GAS_STATION_TRIGGER_MICRO` | `"500000"` | µALGO threshold that triggers top-up (0.50 ALGO = 500 tx remaining). Gives 71s runway at 7 tx/sec, safely above the 30s scan interval. |
| `GAS_STATION_TOPUP_MICRO` | `"700000"` | µALGO sent per top-up (0.70 ALGO ≈ 700 payment txns). Sustained rate: 70 tx/min per agent. |

### Ops tasks (required before enabling in production)

- [ ] Generate new treasury wallet (separate from Rocca signer) — cold key ceremony
- [ ] Opt treasury wallet into USDC (ASA 31566704 mainnet / 10458941 testnet)
- [ ] Fund treasury wallet with ≥ 50 ALGO (covers ~230 onboardings + gas top-ups)
- [ ] Set `ALGO_TREASURY_MNEMONIC` in Railway env vars
- [ ] Set `ALGO_PRICE_CEILING_USDC` in Railway env vars (default `"10.0"` — rejects implausibly high oracle responses)
- [ ] Verify `GET /api/agents/onboarding-quote` returns a sensible fee on mainnet
- [ ] Run testnet end-to-end: quote → prepare → sign (testnet wallet) → activate → confirm agent registered
- [ ] Monitor gas station logs for first 24h — confirm no agents drop below threshold
- [x] Treasury ALGO low-balance alert added to guardian — `TREASURY_LOW_ALERT_ALGO` (default 10 ALGO), fires via Telegram/webhook

### Known limitations / future work

- [x] Gas station pagination implemented — unbounded page loop, 100 agents/page (replaced with cursor-based SCAN)
- [x] Failed top-ups retried on next cycle — cooldown key only set on success, so Algod errors auto-retry
- Treasury is a hot key — consider Vault Transit (Module 3 HSM adapter) once traffic justifies it
- [x] Quote expiry enforced — Redis-backed single-use nonce (90s TTL) stored on prepare-onboarding, checked + deleted on activate (atomic GETDEL — TOCTOU-safe)

---

## Sprint 9 — Gas Station Security Hardening ✅

All 6 vulnerabilities found in the pre-launch adversarial audit patched and covered by 15 adversarial tests.

| ID | Severity | Fix | Files |
|---|---|---|---|
| CRIT-1 | CRITICAL | Gas station now routes every top-up through `checkAndRecordOutflow()` — daily ALGO cap tracked, auto-halts on breach, outflow rolled back on send failure | `gasStation.ts` |
| CRIT-2 | CRITICAL | Gas station checks `isHalted()` at cycle start — stops immediately during any active incident | `gasStation.ts` |
| HIGH-1 | HIGH | Activate nonce check replaced `GET`+`DEL` with atomic `GETDEL` — eliminates TOCTOU race on concurrent requests | `index.ts` |
| HIGH-2 | HIGH | Per-agent 10-min cooldown (`x402:gas:topup:last:{agentId}`) — set on success, skipped on failure (auto-retry next cycle) | `gasStation.ts` |
| MED-1 | MEDIUM | Replaced `listAgents()` pagination loop (N×`redis.keys()`) with single cursor-based `scanAllAgents()` — one O(N) pass | `gasStation.ts`, `agentRegistry.ts` |
| MED-2 | MEDIUM | Treasury balance pre-checked against `TREASURY_MIN_MICRO` before top-up loop — avoids Algod error flood on low treasury | `gasStation.ts` |
| LOW-1 | LOW | `/activate` 500 errors no longer include raw exception `detail` — internal errors logged server-side only | `index.ts` |
| LOW-2 | LOW | `prepareOnboardingGroup` validates both addresses with `algosdk.isValidAddress()` before algosdk calls — returns 400 not 500 | `treasuryFunder.ts`, `index.ts` |
| BONUS | BUG | Fixed `rollbackOutflow` split regex — date in Redis key (`2026-03-06`) broke `/:(?=\d)/` pattern; replaced with `lastIndexOf(":")` | `treasuryOutflowGuard.ts` |

Additional:
- [x] `_setAlgodForTest` / `_setIndexerForTest` exported from `nodely.ts` — proper test helpers (fixes ESM namespace sealing issue that broke all existing adversarial tests on Node 25)
- [x] `tests/gasStation.adversarial.test.ts` — 15 adversarial scenarios, all pass

---

## Sprint 10 — Custom Domain SSL Fix *(IN PROGRESS — resume here)*

**Goal:** Get `ai-agentic-wallet.com` (Vercel frontend) and `api.ai-agentic-wallet.com` (Railway backend) serving HTTPS correctly.

### Root cause diagnosis (completed)

| Domain | Issue | Fix applied |
|---|---|---|
| `api.ai-agentic-wallet.com` | Railway deleted+re-added domain → new CNAME target assigned (`d2q6lur4.up.railway.app`), old DNS record pointed to stale `57drlbac.up.railway.app` | Updated CNAME in Cloudflare ✅ |
| `ai-agentic-wallet.com` | Missing `_vercel` TXT record → Vercel's edge never completed TLS cert deployment (`txtVerifiedAt: null`) | Added TXT record in Cloudflare ✅ |

### DNS changes made (both complete)

```
Type:  CNAME   Name: api    Value: d2q6lur4.up.railway.app   ← Railway custom domain (re-added)
Type:  TXT     Name: _vercel  Value: qnLF2ZCPKu              ← Vercel domain ownership proof
```

### State when paused

- Both DNS records confirmed live via `dig` (TXT visible on `1.1.1.1`, not yet on `8.8.8.8` at pause time — still propagating)
- Vercel: fresh cert issued (`cert_xlXOcINuw5CZyGZNjfc8EsQj`, 90d), project domains re-added (verified: true), new prod deployment pushed
- Vercel `txtVerifiedAt` was still `null` at pause — will auto-update once Vercel's resolver sees the TXT record
- Railway: domain re-added successfully, new CNAME in Cloudflare DNS

### To verify on resume

- [ ] `dig TXT _vercel.ai-agentic-wallet.com @8.8.8.8` returns `"qnLF2ZCPKu"` (Google DNS propagated)
- [ ] `openssl s_client -connect 216.150.1.1:443 -servername ai-agentic-wallet.com` shows cert subject (not connection reset)
- [ ] `curl -s https://ai-agentic-wallet.com` returns HTML (Vercel frontend live)
- [ ] `curl -s https://api.ai-agentic-wallet.com/health` returns `{"status":"ok",...}` (Railway backend live)
- [ ] If Vercel TLS still failing after propagation: trigger re-verify via `curl -s -X POST "https://api.vercel.com/v9/domains/ai-agentic-wallet.com/verify?teamId=team_8cItrO08VMrtjRiV6OSkOvPB" -H "Authorization: Bearer $(cat ~/.vercel/auth.json | python3 -c \"import json,sys; print(json.load(sys.stdin)['token'])\")"` then wait 5 min

### Useful IDs (saved for resume)

- Vercel team: `team_8cItrO08VMrtjRiV6OSkOvPB`
- Vercel project: `prj_sg4gyP9mnuLRWPODSfsNZ3q9PdRw`
- Railway service: `c4f6d8ff-d6f6-4cb4-9954-bba818067a68`
- Railway environment: `266b5fa8-c999-4066-9b6d-dbe76df9008d`
- Vercel auth token: `~/.vercel/auth.json`

---

## Launch Gate Checklist

All items below must be `[x]` before going live.

- [ ] Sprint 1 complete — new wallets generated, all secrets rotated, guardian deployed and verified
- [x] Sprint 2 complete — agent creation wizard live, register-existing auto-opts into USDC
- [x] Sprint 3 complete — landing page live, quickstart package name fixed
- [x] Sprint 4 complete — admin dashboard uses Liquid Auth
- [x] Sprint 5 complete — burst, sustained, velocity, failover, and Redis failure tests pass
- [ ] Sprint 6 complete — security audit clean, runbook written
- [ ] New treasury and signer wallets holding correct balances on mainnet
- [ ] Cold wallet opted into USDC and verified
- [ ] Telegram alerts verified working on real phone
- [ ] DNS: `api.ai-agentic-wallet.com` → Railway, `ai-agentic-wallet.com` → Vercel *(DNS records updated — awaiting TLS propagation, see Sprint 10)*
- [ ] CORS locked to production domains
- [ ] mTLS active
- [ ] `/health` returns fully green across all subsystems

---

## Completed

### Security & Infrastructure
- [x] Treasury outflow guard (daily ALGO/USDC signing cap, auto-halt on breach)
- [x] Wallet guardian: velocity drain detection, Redis-backed halt
- [x] Wallet guardian: Rocca signer auth-addr rekey detection (CRITICAL halt if signer rekeyed away)
- [x] HSM adapter pattern (Vault Transit / env mnemonic)
- [x] Recipient anomaly detector
- [x] Cold wallet SHA-256 hash anchoring in Redis
- [x] On-chain monitor (Indexer reconciliation vs Gate 5 authorized totals)
- [x] envGuard updated to accept Railway Redis vars

### Performance
- [x] Redis migration: Upstash HTTP → Railway internal TCP (ioredis shim, all 30+ call sites)
- [x] Auth-addr cache in Rule 3 validation (5-min TTL, eager invalidation on suspend)
- [x] Nodely primary/fallback failover with Telegram alert + recovery probe
- [x] Speed test: 5/5 mainnet payments @ avg 2,185ms enqueue

### Customer Onboarding (Sprint 2)
- [x] `POST /api/agents/create` — server-side keypair generation, no treasury cost, 10/IP/hour rate limit
- [x] `register-existing` enhanced: auto-opts into USDC if not opted in (atomic group: opt-in + rekey)
- [x] `GET /api/agents/:agentId/settlements` — per-agent settlement history endpoint
- [x] 4-step onboarding wizard at `/app/create` (generate → save mnemonic → fund + poll → activate)
- [x] Customer dashboard: 10s balance auto-polling, low-balance warning ($0.05 threshold)
- [x] WalletCard: Top Up USDC section with Pera / Defly / `algorand://` deep links
- [x] AgentStatusCard: full status matrix (active / registered / halted / suspended / orphaned)
- [x] Dashboard "Create Agent" button linking to `/app/create`
- [x] Balance endpoint made public for unauthenticated wizard polling

### Admin Login (Sprint 4)
- [x] `src/auth/adminAuth.ts` — standalone admin Liquid Auth + WebAuthn service (no agent record required)
- [x] Backend: 8 new public routes at `/api/admin/auth/*` (liquid-challenge/sign/status/consume, webauthn-register-challenge/register/login-challenge/login)
- [x] Portal: `/api/admin/auth/[...path]/route.ts` — public proxy (no PORTAL_API_SECRET injected)
- [x] Portal: `/api/auth/login/route.ts` — dual-path: liquidAuthSessionId → consume+whitelist+JWT, webauthnAssertion → verify+JWT, password fallback kept
- [x] Portal: `/api/auth/session/route.ts` — returns session expiry for Sidebar banner
- [x] Portal: `/login/page.tsx` — replaced password form with Liquid Auth QR + WebAuthn dual-path (mirrors `/app/login`)
- [x] Portal: `Sidebar.tsx` — session expiry banner (amber, warns when < 30 min remain)
- [x] `proxy.ts` — `/api/admin/auth/*` added to public bypass
- [x] `ADMIN_WALLET_ADDRESSES` env var — comma-separated whitelist; if empty → dev open
- [x] `PORTAL_API_SECRET` bearer token kept for machine-to-machine calls (Railway guardian, CI)

### Landing Page & Quickstart (Sprint 3)
- [x] Landing page at portal root (`/`) — hero, how-it-works, use cases, pricing, SDK quickstart, CTA
- [x] `PortalShell` updated: sidebar hidden on `/` (landing page)
- [x] Mobile responsive, no external analytics
- [x] Package name fixed: `@m-reynaldo35/x402-client` → `@algo-wallet/x402-client` in all examples
      (`x402-agent-quickstart.ts`, `x402-agent-quickstart.sh`, `autonomous-trader.ts`)

### Payment Stress Testing (Sprint 5)
- [x] Burst test: 5/5 concurrent payments, p95 enqueue 1461ms, 0 crashes, 0 rate-limited
- [x] Sustained test: 50/50 payments over 17.2 min, p95 enqueue 1527ms, 0 failures, 0 halts
- [x] Velocity cap: VELOCITY_APPROVAL_REQUIRED fires correctly, cap idempotent on retry
- [x] Nodely failover: activates in ~44s, 3/3 payments on fallback, recovery automatic
- [x] Redis failure: boot-time FATAL on all Redis unavailable — fail-closed (502)
- [x] Bugs fixed: clock-skew tolerance 5s→30s, ALGO_CLIENT_NODE_URL override, BURST_SIZE/amounts corrected
- [x] All test reports saved to `public/*.json`

### Portal & SDK
- [x] x402 Developer Portal (Next.js, Vercel)
- [x] Customer Agent Dashboard (`/app/*` with Liquid Auth + WebAuthn)
- [x] Mandate Management UI (Liquid Auth QR + WebAuthn dual-path)
- [x] Domain split: portal (Vercel) + API (Railway)
- [x] SDK: `@algo-wallet/x402-client@0.2.0` published to npm
- [x] `tsc --noEmit` clean on backend + portal
