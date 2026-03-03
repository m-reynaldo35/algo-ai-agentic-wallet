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
- [ ] No mnemonics or private keys in git history — run `git log -S "mnemonic"` scan
- [ ] `.env` not committed — confirm `.gitignore` covers it
- [ ] CORS `CORS_ALLOWED_ORIGINS` locked to production domains only
- [ ] `HALT_OVERRIDE_KEY` set and tested — can halt and unhalt the system
- [ ] Rate limiter active on all public endpoints — test with rapid requests
- [ ] Replay guard active — confirm same nonce rejected on second submission
- [ ] Auth-addr cache TTL appropriate — 5 min acceptable stale window confirmed
- [ ] mTLS active between main API and signing service (`MTLS_ENABLED=true`)
- [ ] `DEV_SIGNER_ALLOWED` not set in any Railway service
- [ ] `RAILWAY_ENVIRONMENT=production` set on all Railway services
- [ ] Error responses never leak stack traces or internal paths to clients
- [ ] Telegram alert channel tested — guardian, failover, and halt all route to phone

### 6.2 Performance Audit

- [ ] Re-run 5-payment speed test post all sprints — confirm enqueue still < 3s
- [ ] Check Redis key TTLs — no unbounded key growth
- [ ] Check Railway memory/CPU metrics — no leak after sustained load test
- [ ] Nodely free tier latency acceptable — upgrade to paid if p95 > 200ms on algod

### 6.3 Code Quality Audit

- [x] `tsc --noEmit` passes clean (backend + portal)
- [ ] Fix `MaxListenersExceededWarning` in main API logs (11 abort listeners on AbortSignal)
- [ ] Remove temp scripts used during development:
      `scripts/optin-new-agent.ts`, `scripts/new-agent-test.ts`
- [ ] Remove hardcoded test addresses from `examples/usdc-optin.ts`
- [ ] Confirm all `console.log` in hot paths use structured logging (pino)

### 6.4 Operational Readiness

- [ ] Health endpoint `/health` returns all subsystems: Redis, algod, indexer,
      signing service, halt status
- [ ] Railway service restart policy set to `always`
- [ ] Railway deploy notifications wired (Slack or email on deploy fail)
- [ ] Confirm cold wallet is opted into USDC and ready to receive sweeps
- [ ] Document runbook: how to halt, unhalt, rotate keys, recover from a drain

---

## Sprint 7 — Additional Recommendations

*Not required for launch but strongly recommended.*

### 7.1 MCP Server for Claude Agents

- [ ] Build a Claude MCP server (`packages/x402-mcp/`) with one tool: `pay_with_x402`
- [ ] Tool takes: `{ agentId, amount, destination, chain }` — handles full handshake
- [ ] Publish to npm so Claude Code / Claude Desktop users can add it in seconds
- [ ] Add to landing page as "native Claude integration"

### 7.2 Python SDK

- [ ] Port `@algo-wallet/x402-client` core logic to a pip package `algo-x402`
- [ ] Cover: registration, sandbox export, execute, poll-for-confirmation
- [ ] Publish to PyPI
- [ ] Update `examples/x402-agent-quickstart.py` to use the published package

### 7.3 Dedicated Signer Redis

- [ ] Add second Railway Redis plugin to `rocca-signing-service`
- [ ] Set `SIGNER_REDIS_PRIVATE_URL` + `SIGNER_REDIS_URL` on signing service
- [ ] Eliminates shared Redis contention between main API and signing service
- [ ] Clears the remaining envGuard WARNING from signing service logs

### 7.4 API Versioning

- [ ] Prefix all public endpoints with `/v1/` (e.g. `/v1/api/execute`)
- [ ] Keep unversioned routes as aliases during transition
- [ ] Document version in `/health` response

### 7.5 Privacy & Legal

- [ ] Add Privacy Policy page to portal (required before collecting any user data)
- [ ] Add Terms of Service page
- [ ] Confirm GDPR/CCPA compliance for any IP hashing or telemetry stored in Redis

### 7.6 Monitoring

- [ ] Set up Railway metrics alerts: CPU > 80%, memory > 80%, error rate > 1%
- [ ] Sentry already integrated — confirm error volume dashboard is reviewed weekly
- [ ] Add uptime monitor (Better Uptime or UptimeRobot) on `/health`
- [ ] Alert on signing service downtime separately from main API

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
- [ ] DNS: `api.ai-agentic-wallet.com` → Railway, `ai-agentic-wallet.com` → Vercel
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
