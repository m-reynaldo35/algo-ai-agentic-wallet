# algo-wallet — Production Roadmap

> **Purpose:** Step-by-step execution plan covering infrastructure launch through ecosystem buildout.
> Revisit this file at the start of every session to pick up where we left off.
> Mark items `[x]` as they are completed.

---

## Vision

**Phase 1 — Infrastructure** *(current)*
An AI autonomous wallet bound to a human, with mandate-gated spending and an Algorand USDC payment rail.

**Phase 2 — Ecosystem** *(next)*
A discoverable marketplace where AI agents autonomously find, pay for, and consume API services using the payment rail — buyers and sellers matched by Claude and other LLMs through MCP tool discovery.

```
Human sets mandate (spending limits)
    ↓
AI Agent (autonomous wallet)
    ↓
x402-Algorand payment rail (USDC, ~$0.0002/txn, 3.8s finality)
    ↓
API Registry / MCP Aggregator  ←─── Sellers list their APIs here
    ↓
Claude discovers tool → pays → gets data → answers user
```

---

## Current State (after Sprint N + UX unification)

- Railway backend live: `https://api.ai-agentic-wallet.com`
- Vercel frontend live: `https://ai-agentic-wallet.com`
- Redis internal TCP active — p95 enqueue 1.53s, avg ~1.25s
- Auth-addr cache (5-min TTL) eliminates algod round-trips
- Nodely failover active (primary → fallback + recovery probe)
- SDK `@algo-wallet/x402-client@0.2.0` — built, not yet published to npm
- MCP server `@algo-wallet/x402-mcp@0.1.0` — built, not yet published
- Python SDK `algo-x402@0.1.0` — built, not yet published
- CLI `@algo-wallet/x402-cli@0.1.0` — built, not yet published
- **Gas station removed** — replaced by ALGO-triggered activation poller
- **Agent activation**: user sends 0.5 ALGO → server detects + opts-in + rekeys automatically
- **Gas warning headers**: `X-Agent-Gas-Status` + `X-Agent-Gas-Remaining` on every payment response
- **Refuel UI**: WalletCard shows gas warnings (low/critical) + Refuel modal with deep links
- **Guardian**: agent gas critical alerts firing via Telegram (30-min cooldown per agent)
- **Unified sign-in** (`/sign-in`): single Pera Connect page smart-routes admin → `/dashboard`, customers → `/app/dashboard`; `/login` + `/app/login` are redirect aliases
- `ADMIN_WALLET_ADDRESSES` set — admin wallet confirmed working, wrong wallet gets 403
- Customer dashboard: mandates inline, revoked counts, wallet QR sidebar, agent status card
- Multi-agent portfolio: one wallet → N agents, pending agents shown with amber dot
- Admin portal: all pages built (dashboard, treasury, agents, security, logs, settings)
- `tsc --noEmit` passes clean on backend + portal + x402-client + x402-cli

---

# PHASE 1 — Infrastructure Launch

## Sprint 1 — Security Foundations *(ops tasks remain)*

### 1.1 New Treasury + Rocca Signing Wallets

- [x] Generate new treasury wallet
- [x] Generate new signer wallet
- [x] Generate new cold wallet
- [x] Store mnemonics in password manager
- [x] Set new `X402_PAY_TO_ADDRESS` in Railway env vars
- [x] Set new `ALGO_TREASURY_MNEMONIC` and `ALGO_SIGNER_ADDRESS` in Railway shared vars
- [x] Rotate `ROCCA_API_KEY`, `PORTAL_API_SECRET`, `APPROVAL_TOKEN_SECRET`, `HALT_OVERRIDE_KEY`, `IP_HASH_SALT`
- [x] Opt treasury into USDC (ASA 31566704)
- [x] Opt cold wallet into USDC (ASA 31566704)
- [x] Fund signer wallet with 200 ALGO
- [x] Re-register the Rocca cohort against the new signer address
- [x] Wipe test Redis data: `REDIS_URL="..." npm run reset-test-data`
- [x] Redeploy `algo-ai-wallet` on Railway after Redis wipe (healthcheck passing, service healthy)
- [x] Delete the failed duplicate service `algo-ai-agentic-wallet` from Railway
- [x] New treasury wallet generated (algosdk 25-word mnemonic), treasury hash reset via `TREASURY_HASH_RESET=true`

### 1.2 Admin Wallet Whitelist

- [x] Set `ADMIN_WALLET_ADDRESSES=<your-algo-address>` on Vercel developer portal env vars
- [x] Verify: scan QR at `/login` with your wallet → redirects to `/dashboard`
- [x] Verify: a different wallet gets 403 "not on the admin whitelist"

### 1.3 Wallet Guardian Audit

- [x] Guardian monitors `ALGO_SIGNER_ADDRESS` balance on every cycle
- [x] Low-balance alert fires when balance < `SIGNER_LOW_ALERT_ALGO`
- [x] Auth-addr rekey detection fires CRITICAL alert + halt
- [x] Deploy guardian to Railway as a separate worker service
- [x] Set `CHECK_INTERVAL_S=10`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` in Railway guardian vars
- [x] Verify Telegram alerts fire end-to-end: `npm run guardian:test`
- [x] Verify treasury USDC sweep fires correctly — txn 5K6ZFCPVONQCKGVA6TIP3HVJPG4NO2OPUMHZ2T5RJSXM6FNLKTDQ ✓

---

## Sprint 6 — System Audit *(ops tasks remain)*

### 6.1 Security Audit
- [x] All secrets rotated (Sprint 1.1)
- [x] No mnemonics in source
- [x] `.env` not committed
- [x] CORS locked to production domains
- [x] `HALT_OVERRIDE_KEY` set in Railway
- [x] Rate limiter active on all public endpoints
- [x] Replay guard active
- [x] Auth-addr cache TTL appropriate — 5-min confirmed
- [x] mTLS active
- [x] `DEV_SIGNER_ALLOWED` not set in Railway
- [x] Error responses never leak stack traces
- [x] Telegram alert channel tested end-to-end

### 6.2 Performance Audit
- [x] p95 enqueue 1527ms (< 3s target)
- [x] Redis key TTLs audited — all bounded
- [x] Halt/unhalt flow tested end-to-end via admin dashboard — working correctly
- [ ] Check Railway memory/CPU metrics — no leak after sustained load
- [ ] Nodely free tier latency acceptable — upgrade to paid if p95 > 200ms

### 6.3 Operational Readiness
- [x] `/health` returns full subsystem status
- [x] Guardian `railway.guardian.json` fixed — restart policy `ALWAYS`
- [x] Runbook written — `docs/runbook.md`
- [x] Railway service restart policy set to `always` on main API
- [x] Railway deploy notifications wired — email on deployment failure ✓
- [x] Cold wallet opted into USDC and ready to receive sweeps (UI3LOTUJ...)

---

## Sprint 10 — Custom Domain SSL *(in progress)*

```
Type:  CNAME   Name: api      Value: d2q6lur4.up.railway.app
Type:  TXT     Name: _vercel  Value: qnLF2ZCPKu
```

- [x] `dig TXT _vercel.ai-agentic-wallet.com @8.8.8.8` returns `"qnLF2ZCPKu"`
- [x] `curl -s https://ai-agentic-wallet.com` returns HTML
- [x] `curl -s https://api.ai-agentic-wallet.com/health` returns `{"status":"ok",...}`

Useful IDs:
- Vercel team: `team_8cItrO08VMrtjRiV6OSkOvPB`
- Vercel project: `prj_sg4gyP9mnuLRWPODSfsNZ3q9PdRw`
- Railway service: `c4f6d8ff-d6f6-4cb4-9954-bba818067a68`

---

## Sprint 11 — Documentation & Security Hardening ✅

- [x] `/docs` standalone public page — own nav, no admin sidebar, no login required
- [x] `DOCS_FOR_AGENTS.md` rewritten — cross-chain removed, sections fixed
- [x] Public test reports sanitised — internal URLs, env var names removed

---

## Sprint 12 — Customer Dashboard ✅

- [x] `/app/mandates` — full mandate management (create/revoke, WebAuthn + Liquid Auth)
- [x] `/app/history` — paginated transaction history with filters + search
- [x] Mandate inline list on dashboard with active/revoked counts
- [x] Revoked mandates visible in revoked tab + counted
- [x] Wallet QR code moved to right sidebar (larger, sticky, with top-up links)
- [x] Agent Status card: auth methods, signing type, network badge, status description
- [x] Wallet address fixed (was showing `webauthn:...` prefix) — now uses `agent.address`
- [x] Balance HTTP 400 fixed — was caused by synthetic webauthn address being passed to indexer
- [x] Mandate expiry required — past dates greyed out in date picker
- [x] `MandateRecord` field names fixed to match backend (`maxPerTx` etc.)

---

## Sprint 13 — Admin Portal ✅

**Goal:** Operational control panel for the operator. Accessible only to admin-authenticated users.

- [x] **System Control** (`/dashboard`):
      Live halt status banner, Halt/Unhalt button, health grid (Redis, algod, indexer,
      signing service), telemetry metrics, settlement volume chart

- [x] **Treasury Monitor** (`/treasury`):
      ALGO + USDC live balances from on-chain, gas station status (enabled/configured/top-up
      amount), daily outflow guard (velocity halts, cap breaches, mass drain, circuit breaker),
      settlement volume cards + daily breakdown table

- [x] **Agent Management** (`/agents`):
      Table of all agents (ID, address, status, cohort, registered date),
      Suspend/Unsuspend, search by agent ID or address, active/suspended filter

- [x] **Security Events** (`/security`):
      Real-time feed: DRAIN_VELOCITY_HALT, SIGNER_KEY_COMPROMISE,
      RECIPIENT_ANOMALY, DAILY_CAP_BREACH — severity badges, mass drain clear dialog
      with HALT_OVERRIDE_KEY, 24h event counts grid, top alerted agents

- [x] **Event Logs** (`/logs`):
      SSE live stream with polling fallback, filter by type, search by agent ID, pause/resume

- [x] **Settings** (`/settings`):
      Alert thresholds, notification toggles (localStorage), rate limits table, config info

- [x] **Sidebar**: Dashboard | Treasury | Agents | Logs | Security | Settings

---

## Sprint 14 — CLI Tool ✅

```bash
npx @algo-wallet/x402-cli health
npx @algo-wallet/x402-cli balance    --agent my-agent-001
npx @algo-wallet/x402-cli mandate list --agent my-agent-001
npx @algo-wallet/x402-cli mandate list --agent my-agent-001 --all   # includes revoked
npx @algo-wallet/x402-cli agents list
npx @algo-wallet/x402-cli history   --agent my-agent-001 --limit 20
```

Env vars required:
- `X402_PORTAL_KEY` — Portal API key (from /dashboard → API Keys)
- `X402_API_URL`    — optional override (default: https://api.ai-agentic-wallet.com)
- `X402_NETWORK`    — optional: `testnet` (default) or `mainnet`

- [x] `packages/x402-cli/` — Node.js CLI using `commander`
- [ ] Publish: `@algo-wallet/x402-cli` to npm

---

## Sprint 15 — Publish SDKs *(planned)*

- [ ] Publish MCP server: `npm publish --access public` from `packages/x402-mcp/`
- [ ] Publish Python SDK: `python -m build && twine upload dist/*` from `packages/algo-x402/`
- [ ] Update `DOCS_FOR_AGENTS.md` with published package names + install commands
- [ ] Update `/docs` page with MCP install instructions

---

## Sprint L — Pera Connect QR Sign-In *(current)*

**Goal:** Replace the custom `algorand-liquid-auth` JSON QR protocol (which Pera does not
understand) with `@perawallet/connect` — Pera's official WalletConnect v2 SDK. No new
infrastructure required. Supports Pera, Defly, Kibisis, and any other WalletConnect wallet.

**References:**
- Pera Connect SDK: https://github.com/perawallet/connect
- WalletConnect docs: https://docs.walletconnect.com
- `@perawallet/connect` npm: https://www.npmjs.com/package/@perawallet/connect

### How It Works

```
Browser (portal)                     WalletConnect Cloud           Pera Wallet (mobile)
      │                                      │                              │
      ├─ new PeraWalletConnect()             │                              │
      ├─ connect() → wc:... URI ────────────►│                              │
      │  Render URI as QR code               │◄─ scan QR ───────────────────┤
      │                                      │◄─ session proposal ──────────┤
      │◄─ sessionUpdate event ───────────────┤                              │
      │  [address confirmed]                 │                              │
      │                                      │                              │
      ├─ POST /api/admin/auth/pera-verify    │                              │
      │  { address, challenge, signature }   │                              │
      │◄─ admin JWT                          │                              │
```

No MongoDB. No signal server. No TURN. WalletConnect relay is hosted by WalletConnect Cloud (free tier).

### L.1 — Backend: Replace Custom Challenge/Verify with Pera Connect Flow ✓

- [x] `src/auth/adminAuth.ts` — added `issueAdminPeraChallenge`, `verifyAdminPeraSignature`, `consumeAdminPeraSession`
- [x] `src/auth/humanAuth.ts` — added `issueAgentPeraChallenge`, `verifyAgentPeraSignature`, `consumeVerifiedPeraSession`
- [x] `src/services/mandateService.ts` — added `peraSessionId` as third auth option in `createMandate` + `revokeMandate`
- [x] `src/index.ts` — added routes: `pera-challenge`, `pera-verify`, `pera-consume` (admin + agent), `pera-register` (agent)
- [x] Portal `/api/auth/login` — added `peraSessionId` path → `pera-consume`
- [x] Portal `/api/customer/auth/login` — added `peraSessionId` path → `pera-register`
- [x] `tsc --noEmit` passes clean on backend

### L.2 — Frontend: Admin Login (`/login`) ✓

- [x] `@perawallet/connect@1.5.1` installed in `apps/developer-portal`
- [x] `src/app/login/page.tsx` rewritten — `PeraConnectPanel` replaces `LiquidAuthPanel`
      - Lazy-loads `PeraWalletConnect` via `useEffect` (browser-only)
      - `connect()` opens built-in WC modal with QR + deeplink
      - `signData()` requests signature from Pera
      - POSTs to `pera-verify` → `peraSessionId` → `/api/auth/login`
- [x] Countdown timer and poll loop removed
- [x] Test: connect Pera → sign → `/dashboard` (confirmed working)
- [x] Test: wrong wallet → 403 confirmed

### L.3 — Frontend: Customer Login (`/app/login`) ✓

- [x] `src/app/app/login/page.tsx` rewritten — `PeraConnectButton` replaces `LiquidAuthQRModal` trigger
- [x] Issues `pera-challenge` with `intent: "register"`, signs, verifies, posts `peraSessionId` to customer login
- [x] Test: customer wallet scan → sign → `/app/dashboard` ✓

### L.4 — Frontend: Mandate Operations ✓

- [x] `LiquidAuthQRModal.tsx` rewritten — uses `PeraWalletConnect` instead of custom JSON QR canvas
      - Auto-starts connect on mount
      - Issues pera-challenge with correct intent, signs, verifies
      - Calls `onVerified(verifiedSessionId)` with pera session ID
- [x] `MandateCreateModal.tsx` — `liquidAuthSessionId` → `peraSessionId`
- [x] `MandateRevokeModal.tsx` — `liquidAuthSessionId` → `peraSessionId`
- [x] Test mandate create: connect Pera → sign → mandate active ✓
- [x] Test mandate revoke: connect Pera → sign → mandate revoked ✓

### L.5 — Cleanup & Verification ✓

- [x] Remove old `/api/admin/auth/liquid-sign` and `/api/agents/:agentId/auth/liquid-sign` routes
- [x] `tsc --noEmit` clean on backend + portal
- [x] Admin login: connect Pera → sign → `/dashboard` ✓
- [x] Admin login: wrong wallet → 403 confirmed ✓
- [x] Customer login: wallet scan → `/app/dashboard` ✓
- [x] Mandate create + revoke: end-to-end with real Pera scan ✓
- [x] WebAuthn removed — defunct passkey option eliminated from all login pages

### L.6 — Unified Sign-In ✓

- [x] `/sign-in` — single Pera Connect page, smart-routes admin → `/dashboard`, customers → `/app/dashboard`
- [x] `/login` → server-side redirect to `/sign-in` (preserves `from` param)
- [x] `/app/login` → server-side redirect to `/sign-in` (preserves `from` param)
- [x] `proxy.ts` — all unauthenticated redirects point to `/sign-in`; sidebar suppressed on `/sign-in`
- [x] Landing page nav + hero CTA updated to `/sign-in`

---

## Sprint M — Payment Rail Redesign ✅

**Goal:** Replace treasury-sponsored agent activation and polling gas station with a
self-sustaining model. User funds their own ALGO gas. Treasury never touches payments.
Revenue is stable USDC. AI agents and humans both work seamlessly.

**Design decisions confirmed:**
- ALGO = fuel (gas + tx fees, user-managed)
- USDC = value (payments to sellers, toll to treasury)
- Toll = 0.01 USDC fixed (stable revenue, no oracle dependency)
- Treasury never in payment hot path
- Gas station polling loop removed entirely
- Atomic refuel = one Pera signature tops up ALGO + USDC together

---

### M1 — ALGO-Triggered Activation

- [x] `POST /api/agents/create` — generates keypair, stores as `pending` in Redis (24h TTL), returns address. No treasury spend.
- [x] Backend polls Algorand indexer every 10s for ALGO deposit ≥ 500,000 µALGO to pending agent addresses
- [x] On deposit detected: use agent original key to sign opt-in to USDC + rekey to Rocca (atomic)
- [x] Mark agent `active` in Redis
- [x] Remove `registerNewAgentWithTreasury()` and sponsored registration logic
- [x] Remove `SPONSORED_DAILY_CAP` anti-sybil (no longer needed — user pays own activation cost)

### M2 — Remove Gas Station

- [x] Delete `gasStation.ts` polling loop
- [x] Remove gas station Redis keys: `x402:gas:*`
- [x] Remove gas station env vars: `GAS_STATION_*`, `TOPUP_COOLDOWN_S`
- [x] Remove gas station Railway worker service ✓
- [x] Update `.env.example`

### M3 — Gas Warning Headers

- [x] After each payment, calculate: `remaining = (algo_balance - MBR) / 1000`
- [x] Add to every payment response:
      ```
      X-Agent-Gas-Status: ok | low | critical
      X-Agent-Gas-Remaining: 847
      ```
- [x] Thresholds: `low` < 200,000 µALGO above MBR — `critical` < 50,000 µALGO above MBR

### M4 — Gas Warning Dashboard + Alerts

- [x] Dashboard warning banner on `/app/dashboard` when gas status is `low` or `critical`
- [x] Telegram alert fires at `critical` threshold — extend existing guardian alert system
- [x] "Refuel" button on dashboard links to atomic refuel flow

### M5 — Atomic Refuel UI

- [x] "Refuel" button on `/app/dashboard` opens Pera with pre-built atomic group:
      - tx0: USDC → agent wallet (spending power)
      - tx1: ALGO → agent wallet (gas buffer)
- [x] Portal calculates recommended ALGO refuel amount based on remaining transactions
- [x] User signs once — both assets arrive atomically

### M6 — Onboarding Wizard Update

- [x] Remove auto-fund step from `/app/create` wizard
- [x] New Step 3: show agent address + QR code + "Send at least 0.5 ALGO to activate"
- [x] Portal polls `/api/agents/{id}` every 5s for server-side activation → wizard advances
- [x] Step 4: "Deposit USDC to start spending"

### M7 — SDK + Docs Update

- [x] `x402-client`: read `X-Agent-Gas-Status` and `X-Agent-Gas-Remaining` headers (`parseGasInfo()`)
- [x] `x402-cli`: add `gas --agent` command showing status + remaining transactions
- [x] `DOCS_FOR_AGENTS.md`: update activation flow, gas headers, `parseGasInfo` example
- [x] `/docs` page: update onboarding guide (portal redeploy needed)

---

## Sprint N — Multi-Agent Identity ✅

**Design principle:** Identity is cryptographic, not custodial. One Algorand wallet = one sovereign
identity. That wallet signs once to enter the dashboard. All agents live under it. The owner's
signature is the root of trust — no passwords, no emails, no re-login between agents.

```
Wallet (identity root)
    │  one Pera sign-in
    ├── Agent A  (trading-bot)      active   ●
    ├── Agent B  (research-agent)   active   ●
    └── Agent C  (new...)           wizard opens inline → lands here on activation
```

### N.1 — CreateAgentWizard Modal Component ✅

- [x] `components/customer/CreateAgentWizard.tsx` — 4-step inline modal wizard
      Steps: Name → Save mnemonic → Send ALGO (polling) → Deposit USDC → back to portfolio
- [x] `ownerAddress` prop injected into `POST /api/agents/create` body — associates agent
      with owner identity immediately (before activation)
- [x] ESC / backdrop click dismisses; confirmation guard on steps 2–3
- [x] `onCreated()` callback — refreshes portfolio list on activation, no page navigation

### N.2 — Pending Agents in Backend Owner Index ✅

- [x] `src/services/agentRegistry.ts` — `PENDING_OWNER_PREFIX` index (`x402:pending-owner:{addr}`)
      Written at `storePendingAgent()` when `ownerAddress` is present
- [x] `listPendingAgentsByOwner()` — reads owner-pending index, strips `secretKeyB64`,
      returns `PendingAgentSummary[]` with `status: "pending"`
- [x] `GET /api/agents?owner=` — merges active + pending; active takes precedence on race

### N.3 — Pending Agents in Portfolio Dashboard ✅

- [x] Portfolio list shows pending agents with amber pulsing dot + "awaiting ALGO" label
- [x] Pending agents display address fragment and "send 0.5 ALGO →" hint
- [x] Pending agents are non-clickable (no `Link` wrapper) — no broken detail page
- [x] `statusLabel()` helper maps all status strings to human-readable labels

### N.4 — Standalone `/app/create` Deprecated ✅

- [x] `/app/create/page.tsx` — redirects to `/app/dashboard` (server-side `redirect()`)
      Users with old bookmarks land in portfolio and create from there

### N.5 — End-to-End Verification ✓

- [x] Wallet scan → sign → portfolio dashboard (no agent ID input anywhere) ✓
- [x] "New Agent" button → inline wizard → agent appears in list with amber "awaiting ALGO" ✓
- [x] Fund agent address → agent transitions amber → emerald in portfolio list ✓
- [x] Click active agent card → `/app/dashboard/{agentId}` → back arrow → portfolio ✓
- [x] Multiple agents created in same session → all visible in list, linked to master wallet ✓
- [x] Issue mandate + revoke mandate end-to-end ✓
- [x] USDC deposit flow working ✓

---

## Launch Gate Checklist

All items below must be `[x]` before going live.

- [x] Sprint 1 complete — new wallets generated, all secrets rotated, guardian deployed, USDC sweep verified ✓
- [x] `ADMIN_WALLET_ADDRESSES` set — admin portal locked to your Algorand wallet ✓
- [x] Sprint 2 complete — agent creation wizard live
- [x] Sprint 3 complete — landing page live
- [x] Sprint L complete — unified sign-in, Pera Connect QR working (admin, customer, mandates) ✓
- [x] Sprint N complete — multi-agent portfolio: one wallet → N agents, inline wizard, no re-login ✓
- [x] Sprint 5 complete — burst, sustained, velocity, failover, Redis failure tests pass
- [x] Sprint 6 complete — security audit clean, Telegram alerts verified, deploy notifications wired ✓
- [x] Sprint M complete — payment rail redesign (ALGO activation, gas warnings, atomic refuel, gas station removed)
- [x] Sprint 10 complete — DNS + TLS verified on both domains ✓
- [x] Sprint 11 complete — docs standalone, security hardening
- [x] Sprint 12 complete — customer dashboard complete
- [x] Sprint 13 complete — admin portal operational
- [x] Treasury and signer wallets holding correct balances on mainnet — signer 1187 ALGO, treasury C66AFZ3... USDC opted-in ✓
- [x] Cold wallet opted into USDC and verified (UI3LOTUJ...)
- [x] Telegram alerts verified working on real phone ✓
- [x] `api.ai-agentic-wallet.com` → Railway, `ai-agentic-wallet.com` → Vercel ✓
- [x] CORS locked to production domains ✓
- [x] mTLS active ✓
- [ ] `/health` returns fully green across all subsystems

---

# PHASE 2 — Ecosystem (The Marketplace)

> **Why this matters:** The buyer side is built — an AI agent with a wallet, mandate-gated
> spending, and a payment rail. Phase 2 builds the seller side and the discovery layer that
> connects them. Claude and other LLMs do the matching automatically through MCP tool discovery.
> This is the AI agent economy layer that EVM x402 cannot serve due to gas economics.

---

## Sprint 16 — End-to-End Payment Test ✅ *(completed with findings)*

**Result:** Real $0.01 USDC payment confirmed on Algorand mainnet (round 59,427,810).
Txn: `SJU6VBOOWLQ5X7YM2F22LGOVSC6QNIPRT5K4ACGTVJJ5RZDONIBQ`
Weather data delivered for Lagos, Nigeria: 28.6°C, 9.1 km/h, code 3.

- [x] `POST /api/weather` endpoint added to `src/index.ts` behind `x402Paywall` — proxies Open-Meteo (free, no API key), returns temperature/wind/weather_code/timestamp + USDC payment sandbox
- [x] `scripts/buy-weather.ts` — end-to-end test: health check → 402 absorbed via `requestWithPayment` → weather data + sandbox returned → `/api/execute` → job polled to confirmed
- [x] `weather-test-agent` registered and rekeyed to production signer (`6RZV6XEP6...`)
- [x] Async job queue polling added to buy-weather.ts (server returns `{queued:true, jobId}`)
- [x] USDC transferred on-chain, Pera Explorer link logged

**Critical issues found — tracked in Sprint 16A below.**

### What worked
- Open-Meteo geocoding + weather fetch: zero friction
- 402 bounce + proof absorption: worked as designed
- Async job queue + polling: job confirmed in ~3s
- Auth-addr Rule 3 validation: correctly caught signer mismatch (security layer working)
- Railway deploy cycle: new endpoint live in ~2 min

### What was broken or missing
- x402 payment is not atomic: data delivered before USDC confirmed on-chain (see 16A.1)
- Two different signer keys: local `.env` `ALGO_SIGNER_MNEMONIC` derives to `2FBKPEID...` (Cohort A), Railway uses `6RZV6XEP6...`; speed-test-agent was rekeyed to the wrong one, Sprint 5 results not reliable as production indicators (see 16A.2)
- X-PAYMENT proof contains a USDC txn signed by the agent's original key — invalid for rekeyed accounts if ever submitted; middleware only checks the ed25519 signature over groupId, not txn validity (see 16A.3)
- SDK `requestSandboxExport` hardcoded to `/api/agent-action` — any new x402 endpoint requires importing interceptor internals (see 16A.4)
- `railway variables` truncates long secrets in display — spent a full debugging cycle on a 40-char vs 64-char `PORTAL_API_SECRET` mismatch (see 16A.5)
- `setup-sprint16-agent.ts` left as a one-off throwaway with hardcoded addresses (see 16A.6)

---

## Sprint 16A — x402 Protocol Correctness & Operational Hardening

**Why:** Sprint 16 confirmed the payment rail works mechanically but exposed six structural
problems. These must be fixed before Phase 2 sellers join — the protocol design affects every
endpoint we build and every SDK integration downstream.

---

### 16A.1 — Fix Payment Atomicity (Critical)

**Problem:** `POST /api/weather` returns weather data the moment `x402Paywall` verifies the
payment *proof*. The actual USDC transfer only happens if the client then calls `/api/execute`.
A client could take the weather data and never settle. Data delivery is not causally linked to
confirmed payment.

**Root cause:** `x402Paywall` verifies an ed25519 signature over a groupId — it's a proof of
intent, not proof of payment. The actual USDC movement goes through `/api/execute`, which is a
separate, optional call.

**Fix — Receipt-gated model:**
- Client calls `/api/execute` first to pay → receives `txnId` (confirmed on-chain)
- Client calls `POST /api/weather` with header `X-PAYMENT-RECEIPT: <txnId>`
- `x402Paywall` (or a new `x402Receipt` middleware) verifies: txnId exists on Algorand,
  amount matches price, receiver matches treasury, txn not already redeemed (replay guard)
- Only then delivers the resource

**Alternative (simpler, synchronous):**
- Weather endpoint calls `/api/execute` internally and waits for confirmation before returning
  weather data. Slower (adds ~4s) but fully atomic and requires no client-side changes.

- [ ] Decide on model: receipt-gated vs internal synchronous settlement
- [ ] Implement chosen model in `x402Paywall` or a new `x402Receipt` middleware
- [ ] Update `buy-weather.ts` to use the new flow
- [ ] Update `POST /api/weather` to follow atomic delivery pattern
- [ ] Update spec comment in `src/middleware/x402.ts` to reflect actual behaviour
- [ ] Add integration test: verify data is NOT returned if payment step is skipped

---

### 16A.2 — Unify Signer Keys: Dev = Prod

**Problem:** Two different signer keys exist in the same codebase:

| Context | `ALGO_SIGNER_MNEMONIC` derives to | Role |
|---|---|---|
| Local `.env` | `2FBKPEID...` | Cohort A / dev signer |
| Railway production | `6RZV6XEP6...` | Production signer |

Agents registered locally (speed-test-agent) are rekeyed to the dev signer, making them
incompatible with the production server. Sprint 5 stress test results may not reflect
current production behaviour since the environment has drifted.

- [ ] Either: update local `.env` `ALGO_SIGNER_MNEMONIC` to the production key (requires
      re-registering all local test agents) — preferred for fidelity
- [ ] Or: document the two-key setup explicitly; add a warning on boot if local signer ≠
      Railway signer and `NODE_ENV=production`
- [ ] Re-register speed-test-agent against the production signer (rekey on-chain from Cohort A → prod)
- [ ] Re-run Sprint 5 stress test against the current production configuration to get trustworthy
      baseline numbers — previous results were on a different signer setup
- [ ] Add boot assertion: `if (derivedSignerAddr !== config.algorand.signerAddress) throw Error("Signer key/address mismatch")`

---

### 16A.3 — Fix X-PAYMENT Proof for Rekeyed Agents

**Problem:** `requestWithPayment` in the client interceptor builds a USDC transfer signed by
`privateKey` — the agent's original key. For rekeyed agents, this signature is invalid on
Algorand (requires the auth-addr's key). `x402Paywall` only checks the ed25519 signature over
the groupId, not whether the embedded transaction would pass Algorand validation. So the proof
passes middleware verification, but if the signed transaction were ever submitted on-chain it
would be rejected.

This is a latent correctness bug: the X-PAYMENT header contains a transaction that cannot be
broadcast for any custodially-managed (rekeyed) agent.

- [ ] Option A: Remove the signed USDC transaction from the X-PAYMENT proof entirely for
      custodial agents. The proof becomes: `{ groupId, senderAddr, signature }` only — no txn.
      Update `buildPaymentProof` in interceptor to skip transaction construction when agent is rekeyed.
- [ ] Option B: Have the server sign the USDC transaction on behalf of the agent in the
      X-PAYMENT verification step, making X-PAYMENT a valid submittable payload.
- [ ] Update `x402Paywall` to document clearly: "verifies proof of identity, not proof of
      submittable payment" until Option A/B is resolved
- [ ] Add a comment in `buildPaymentProof` warning that signed txn is invalid for rekeyed accounts

---

### 16A.4 — Make SDK Client URL-Generic

**Problem:** `AlgoAgentClient.requestSandboxExport()` is hardcoded to `/api/agent-action`.
Any new x402-gated endpoint (weather, news, FX, crypto price) requires importing
`requestWithPayment` directly from the interceptor — a lower-level internal not part of the
public API contract.

- [ ] Add to `AlgoAgentClient`:
      ```typescript
      async fetch(path: string, init?: RequestInit): Promise<Response>
      ```
      Calls `requestWithPayment` with `${this.baseUrl}${path}`, using `this.privateKey` and
      `this.senderAddress`. Returns the raw `Response` — caller parses the body.
- [ ] Export `requestWithPayment` as a documented public API (it already is, but add JSDoc)
- [ ] Update `buy-weather.ts` to use `client.fetch("/api/weather", {...})` instead of importing
      the interceptor directly
- [ ] Add example to `DOCS_FOR_AGENTS.md`: calling a custom x402 endpoint

---

### 16A.5 — Add `verify-env.ts` Sanity Check Script

**Problem:** `railway variables` truncates long values in its display output (showed 40 chars
of a 64-char `PORTAL_API_SECRET`). Spent a full debugging cycle on a non-existent auth failure.
No tooling exists to diff local `.env` against Railway production config.

- [ ] Write `scripts/verify-env.ts`:
      - Uses `railway run node -e` to echo each critical env var from production
      - Compares: `PORTAL_API_SECRET`, `ALGO_SIGNER_ADDRESS`, `ALGO_SIGNER_MNEMONIC` (derived address only), `X402_PAY_TO_ADDRESS`, `UPSTASH_REDIS_REST_URL`
      - Outputs: `✓ match` / `✗ MISMATCH (local: X, railway: Y)` for each
      - Run before every sprint that touches auth or signing
- [ ] Add to `package.json` scripts: `"verify-env": "npx tsx scripts/verify-env.ts"`
- [ ] Document: "Run `npm run verify-env` before debugging auth or signing failures"

---

### 16A.6 — Harden Agent Registration Flow

**Problem:** `setup-sprint16-agent.ts` has hardcoded addresses, hardcoded mnemonics, and is a
one-off throwaway script. The real problem it solved (registering a test agent against the
production signer) should be a proper reusable utility.

- [ ] Delete or archive `scripts/setup-sprint16-agent.ts` (hardcoded values, not reusable)
- [ ] Write `scripts/register-agent.ts` — generic CLI:
      ```bash
      npx tsx scripts/register-agent.ts \
        --agent-id my-agent \
        --fund-algo 0.6 \          # ALGO to send from funding wallet
        --fund-usdc 50000 \        # µUSDC to send from funding wallet
        --funding-mnemonic-env FUNDING_MNEMONIC
      ```
      Generates fresh keypair, funds it, registers via API, prints new AGENT_ID + ALGO_MNEMONIC
- [ ] Ensure register-agent.ts works for both dev (local signer) and prod (Railway signer)
      by reading ALGO_SIGNER_ADDRESS from env, not hardcoding

---

### 16A.7 — Fix buy-weather.ts Banner Formatting

**Problem:** The banner columns are misaligned for several fields due to fixed-width padding
not accounting for URL length variance.

- [ ] Fix column alignment in the banner — use consistent padding or drop fixed-width format
- [ ] Add `CITY` env var to `.env.example` with a note

---

**Completion criteria for 16A:** `buy-weather.ts` runs end-to-end with USDC moving atomically
*as a precondition* to data delivery, local and production signers are aligned, and `npm run
verify-env` passes clean.

---

## Sprint 17 — x402-Algorand Formal Standard

**Why:** The payment format is already built. Publishing it as a named, versioned spec
lets other developers build compatible sellers and buyers without reading source code.
Positions as "x402 on Algorand" — extending Coinbase's x402 brand rather than competing.

### 17.1 Spec Document
- [ ] Create `docs/x402-algorand-spec.md` — the canonical spec:
      - Payment request format (402 response body)
      - Payment proof format (`X-PAYMENT` header)
      - Network identifier: `algorand-mainnet` / `algorand-testnet`
      - Asset: USDC (ASA 31566704 mainnet, 10458941 testnet)
      - Replay protection: `expiresAt` Unix ms, nonce uniqueness
      - Error codes and retry behaviour
- [ ] Publish spec as public GitHub Gist or dedicated repo `x402-algorand-spec`

### 17.2 Discovery Headers
- [ ] Add to 402 response: `X-Payment-Network: algorand-mainnet`
- [ ] Add to 402 response: `X-Payment-Asset: USDC`
- [ ] Add `GET /.well-known/x402` endpoint:
      ```json
      {
        "version": "x402-algo-v1",
        "networks": ["algorand-mainnet"],
        "assets": ["USDC"],
        "assetIds": { "algorand-mainnet": 31566704 }
      }
      ```
- [ ] x402-client: auto-detect network from `X-Payment-Network` header before building proof

### 17.3 Package Positioning
- [ ] Add `x402-algorand` as an npm alias for `@algo-wallet/x402-client` (discoverability)
- [ ] Add `x402-algorand-middleware` as an alias for the server middleware
- [ ] README: "x402 payment protocol implemented for Algorand USDC"
- [ ] Update package keywords: `x402`, `algorand`, `usdc`, `micropayments`, `ai-agents`

---

## Sprint 18 — Seller SDK

**Why:** The seller side is the missing half. Developers need to be able to add
x402-Algorand payment to their API in one import. The easier it is to become a seller,
the faster the registry fills.

### 18.1 x402-mcp Seller SDK (complete the existing package)
- [ ] Single import API:
      ```typescript
      import { x402tool } from "@algo-wallet/x402-mcp";

      x402tool({
        name:        "get_weather",
        description: "Current weather for any city. Costs $0.001 USDC.",
        price:       1000,         // micro-USDC
        payTo:       "ALGO_ADDRESS",
        input:       { city: "string" },
        handler:     async ({ city }) => fetchWeather(city),
      });
      ```
- [ ] Handles: 402 response generation, payment proof verification, mandate enforcement check
- [ ] Express adapter: `app.use(x402express({ price, payTo }))` — one-line middleware
- [ ] FastAPI adapter (Python): `@x402(price=1000, pay_to="ALGO_ADDRESS")`
- [ ] Seller CLI: `npx x402-algorand register --tool get_weather --endpoint https://myapi.com`

### 18.2 Seller Documentation
- [ ] Quickstart: "Add x402 payment to your API in 5 minutes"
- [ ] Pricing guide: micro-USDC denomination, recommended price tiers
- [ ] Security guide: replay protection, mandate-aware rate limiting

---

## Sprint 19 — API Registry

**Why:** Discovery without a registry is impossible. The registry is the catalogue that
agents query to find what's available to buy. It also creates the flywheel: more sellers
→ more useful APIs for agents → more agents → more revenue for sellers.

### 19.1 Backend Registry
- [ ] `POST /api/registry/list` — register a new tool:
      ```json
      {
        "name":        "get_weather",
        "description": "Current weather for any city",
        "endpoint":    "https://myapi.com/weather",
        "price":       1000,
        "category":    "data",
        "network":     "algorand-mainnet"
      }
      ```
- [ ] `GET /api/registry` — list all verified tools (JSON + optional category filter)
- [ ] Verification: server pings `endpoint/.well-known/x402` — only verified endpoints listed
- [ ] Add weather endpoint (`/api/weather`) as entry #1 automatically at boot

### 19.2 Registry Frontend Page
- [ ] New public page at `ai-agentic-wallet.com/registry`:
      - Card grid of listed APIs: name, description, price, category
      - Filter by category (data, compute, finance, AI, utility)
      - "List your API" button → seller registration form
      - Copy MCP endpoint URL button per listing
- [ ] No auth required to browse — public discovery page

### 19.3 Registry in DOCS_FOR_AGENTS.md
- [ ] Section: "Discoverable APIs" — lists all registry entries with endpoint + price
- [ ] Agents reading the docs can find what's available to buy without querying the API

---

## Sprint 20 — Aggregator MCP Server (The Bazaar)

**Why:** This is the highest-leverage piece. Instead of users adding one MCP server per API,
they add one aggregator MCP server and instantly get access to every listed API.
Claude picks the right tool for the task. Payment fires automatically. The human's mandate covers it.

### 20.1 Aggregator Architecture
```
User → "check the weather in Lagos"
    ↓
Claude scans available tools via aggregator MCP
    ↓
Finds: get_weather (costs $0.001 USDC, via x402-Algorand)
    ↓
Claude calls tool → aggregator fires x402 payment from agent wallet
    ↓
Mandate check passes → USDC paid → weather data returned
    ↓
Claude answers user
```

### 20.2 Implementation
- [ ] `packages/x402-mcp/src/aggregator.ts` — MCP server that:
      - Polls `/api/registry` on start + every 5 min
      - Exposes each registry entry as an MCP tool dynamically
      - Handles x402 payment on tool call using agent wallet credentials
      - Returns tool result to the calling LLM
- [ ] Tool schema auto-generated from registry entry `input` schema
- [ ] Payment credentials: agent provides `AGENT_MNEMONIC` + `AGENT_ID` env vars
- [ ] Mandate enforcement: aggregator checks mandate before every payment
- [ ] Publish: `npx @algo-wallet/x402-mcp` — one command starts the aggregator

### 20.3 Configuration
```bash
# .env for the aggregator MCP server
X402_REGISTRY_URL=https://api.ai-agentic-wallet.com/api/registry
AGENT_ID=my-agent-001
AGENT_MNEMONIC=<25 words>
MAX_PER_CALL_USDC=1.00   # hard ceiling per tool call
```

### 20.4 Claude Desktop Integration
- [ ] `claude_desktop_config.json` snippet in docs:
      ```json
      {
        "mcpServers": {
          "x402-marketplace": {
            "command": "npx",
            "args": ["@algo-wallet/x402-mcp"],
            "env": {
              "AGENT_ID": "my-agent-001",
              "AGENT_MNEMONIC": "..."
            }
          }
        }
      }
      ```
- [ ] Submit to Anthropic MCP integrations directory
- [ ] Submit to `mcp.so` and `smithery.ai` registries

---

## Sprint 21 — Seller Acquisition & Registry Growth

**Why:** A marketplace with one listing is not a marketplace. Need to seed the registry
with enough variety that agents have real choices. Target: 10 listed APIs across 5 categories.

### 21.1 First-Party APIs (build these on the backend — dogfood the seller SDK)
- [ ] `GET /api/weather?city=` — current weather via Open-Meteo ($0.001)
- [ ] `GET /api/fx?from=USD&to=NGN` — FX rates via Open Exchange Rates ($0.002)
- [ ] `GET /api/news?topic=` — headlines via NewsData.io free tier ($0.005)
- [ ] `GET /api/geocode?address=` — address → lat/lng via Nominatim ($0.001)
- [ ] `GET /api/crypto/price?symbol=ALGO` — crypto price via CoinGecko free ($0.001)

### 21.2 Third-Party Seller Outreach
- [ ] Write "Become a Seller" landing page at `/sell`:
      - "Your API earns USDC every time an AI agent calls it"
      - Setup guide: 3 steps, one npm install
      - Earnings calculator: N calls/day × $0.001 = $X/month
- [ ] Reach out to 5 API providers in the Algorand ecosystem
- [ ] Write blog post: "How to monetise your API for AI agents with Algorand USDC"

### 21.3 Matching Quality
- [ ] Registry entries include structured tags: `["weather", "geo", "real-time"]`
- [ ] Aggregator MCP tool descriptions written for LLM tool selection (not humans)
- [ ] Test: Claude correctly picks `get_weather` over `get_news` for "what's the weather"

---

# PHASE 3 — Algorand DeFi Automation *(optional, high value)*

> **Why this matters:** The Bazaar (Phase 2) depends on third-party sellers joining — a
> 12–18 month ecosystem play with real execution risk. Phase 3 requires no external
> participants. The wallet infrastructure (signing, mandates, guardian, atomic groups) is
> already the right foundation. These sprints add a DeFi intelligence layer on top of it.
> An agent autonomously managing a Tinyman/Folks Finance position is a more compelling
> near-term demo than a marketplace with five listings.
>
> **Prerequisite:** Sprint 16A complete (signer keys unified, payment atomicity fixed).
> **These sprints are independent of each other** — pick the platform that makes most
> sense to prioritise and build that integration first.

---

## Sprint D1 — Price Feed & DEX Primitives

**Why first:** Every DeFi strategy — arbitrage, portfolio rebalancing, position monitoring —
needs a reliable real-time price layer. This sprint builds the shared foundation all
subsequent DeFi sprints depend on.

### D1.1 — Vestige / Pool Price Integration
- [ ] `src/defi/prices.ts` — `getAssetPrice(assetId)` via Vestige free API
      Returns: mid price in USDC, 24h change %, liquidity depth
- [ ] `src/defi/pools.ts` — `getTinymanPoolState(assetA, assetB)` via Tinyman V2 API
      Returns: reserve amounts, current price, fee tier, pool address
- [ ] Poll prices on a configurable interval (default 30s), cache in Redis with TTL
- [ ] Expose via `GET /api/defi/price?asset=ALGO` — agent-readable price endpoint
- [ ] Unit tests: mock Vestige + Tinyman responses, verify price parsing

### D1.2 — Tinyman Swap Transaction Builder
- [ ] `src/defi/tinyman.ts` — `buildTinymanSwap(params)`:
      - `assetIn`, `assetOut`, `amountIn`, `slippageBips`
      - Fetches current pool state, calculates `amountOutMin`
      - Returns unsigned atomic group: [asset opt-in if needed, swap app call, fee txn]
- [ ] Integrates with existing `constructAtomicGroup` pattern — same sandbox export shape
- [ ] Slippage guard: abort if price impact > configurable threshold (default 1%)
- [ ] Swap simulation: `simulateTinymanSwap()` — returns expected output before committing

### D1.3 — Dashboard: DeFi Price Widget
- [ ] Add live ALGO/USDC price card to `/app/dashboard` — pulls from `/api/defi/price`
- [ ] Small 24h sparkline using existing chart components
- [ ] No auth required for price data — public endpoint

---

## Sprint D2 — Lofty Real Estate Agent

**Why:** Lofty is the most accessible Algorand DeFi integration. Property tokens are
standard ASAs. Daily rental income arrives in USDC/ALGO automatically. An agent that
autonomously optimises a Lofty portfolio (rebalancing across properties by yield, compounding
rental income) is a concrete, explainable use case with no market-timing risk.

### D2.1 — Lofty API Integration
- [ ] `src/defi/lofty.ts` — Lofty API client:
      - `getProperties()` — list all available properties with yield %, token price, available supply
      - `getPortfolio(agentAddress)` — agent's current property token holdings + accrued rental income
      - `buildPropertyPurchase(propertyId, tokenAmount)` — unsigned ASA transfer to Lofty marketplace
      - `buildRentalHarvest(agentAddress)` — collect pending rental income
- [ ] Map Lofty property ASA IDs — maintain a seeded registry of known property token IDs
- [ ] Rate: poll agent Lofty portfolio every 60s when active

### D2.2 — Lofty Strategy Engine
- [ ] `src/defi/strategies/loftyRebalance.ts`:
      - Input: agent mandate + strategy config (min yield threshold, max allocation per property, compound: bool)
      - Logic: identify properties below yield threshold → sell; identify higher-yield properties → buy
      - Respects per-tx mandate cap — no single rebalance exceeds cap
      - Output: ordered list of unsigned swap instructions
- [ ] `src/defi/strategies/loftyCompound.ts`:
      - Harvests accrued rental income automatically
      - Reinvests into highest-yield available property within mandate
      - Runs on configurable schedule (default: daily)

### D2.3 — Agent Strategy Config (Dashboard)
- [ ] New section on `/app/dashboard/{agentId}`: "DeFi Strategy"
- [ ] Lofty strategy toggle: enable/disable
- [ ] Config fields: min acceptable yield %, max % of wallet in single property, compound toggle
- [ ] Strategy activity log: shows each rebalance action + outcome inline

### D2.4 — End-to-End Test
- [ ] Fund test agent with $10 USDC
- [ ] Configure Lofty rebalance strategy
- [ ] Verify agent purchases a property token autonomously within mandate
- [ ] Verify rental income compounded correctly after 24h
- [ ] All transactions visible in dashboard history with Pera Explorer links

---

## Sprint D3 — Tinyman / Pact Arbitrage Agent

**Why:** Multiple AMM DEXes on Algorand (Tinyman, Pact, Humble, Cometa) trade the same
assets at slightly different prices. An agent that detects and atomically exploits these
discrepancies earns profit from pure market inefficiency — no prediction required.
Atomicity (built into Algorand + our existing transaction pipeline) means no execution risk:
if the arbitrage isn't profitable after slippage, the whole group reverts.

### D3.1 — Multi-DEX Price Scanner
- [ ] `src/defi/arbitrage/scanner.ts` — polls Tinyman + Pact + Humble pool states every 5s
- [ ] `detectArbitrageOpportunity(assetA, assetB, minProfitBips)`:
      - Compares effective price across all DEX pairs
      - Accounts for swap fees (0.3% Tinyman, 0.25% Pact) and Algorand tx fees
      - Returns opportunity if net profit after fees exceeds `minProfitBips` (default: 20 bips = 0.2%)
- [ ] Logs detected opportunities to Redis with timestamp + estimated profit

### D3.2 — Atomic Arbitrage Transaction Builder
- [ ] `src/defi/arbitrage/builder.ts` — `buildArbitragePair(opportunity)`:
      - Constructs 2-leg atomic group: buy on DEX A → sell on DEX B
      - Both swaps in one Algorand atomic group — guaranteed profitable or fully reverted
      - Includes fee txn (x402 toll to treasury)
      - Slippage guard per leg: abort if either leg degrades past threshold
- [ ] Simulation before execution: verify profit still valid at current pool state
- [ ] Max position size: never exceed per-tx mandate cap

### D3.3 — Arbitrage Agent Strategy Config
- [ ] Dashboard config: min profit threshold (bips), max position size (USDC), active pairs
- [ ] Real-time opportunity log: shows detected + executed opportunities with P&L
- [ ] Daily P&L summary card on `/app/dashboard/{agentId}`
- [ ] Auto-pause if 3 consecutive failed executions (protection against scanner lag)

### D3.4 — End-to-End Test
- [ ] Run scanner against mainnet, verify opportunity detection fires correctly
- [ ] Execute one real arbitrage with test agent ($5 max position)
- [ ] Verify both legs confirmed atomically on Pera Explorer
- [ ] Verify mandate cap respected — oversized opportunity rejected cleanly

---

## Sprint D4 — Folks Finance Position Manager

**Why:** Folks Finance is Algorand's largest lending protocol. Borrowers can be liquidated
when their collateral value drops. Liquidation bots earn a bonus (typically 5–10%) for
closing undercollateralised positions. This is the most mechanical DeFi opportunity —
no market prediction, just monitoring on-chain state and acting within seconds.
Separately, agents can manage their own lending positions to maximise yield while
staying safe from liquidation.

### D4.1 — Folks Finance On-Chain Reader
- [ ] `src/defi/folks/reader.ts` — reads Folks Finance V2 contract state:
      - `getAllPositions()` — active borrower positions with collateral ratio, borrow amount, liquidation threshold
      - `getAgentPosition(agentAddress)` — this agent's own loans (if any)
      - `getLiquidationBonus(poolId)` — current liquidation incentive per market
- [ ] Poll all positions every 15s, cache in Redis
- [ ] Alert via existing Telegram guardian if agent's own LTV > 70% (configurable threshold)

### D4.2 — Liquidation Bot
- [ ] `src/defi/folks/liquidator.ts` — `buildLiquidationTxn(position)`:
      - Constructs Folks Finance liquidation app call for undercollateralised position
      - Calculates max repayable amount within mandate cap
      - Atomic group: USDC repayment → receive collateral asset → optional swap back to USDC
- [ ] `src/defi/strategies/liquidationMonitor.ts`:
      - Watches all positions from D4.1 reader
      - Fires liquidation when health factor drops below 1.0
      - Respects mandate per-tx cap — doesn't over-commit
      - Logs every liquidation attempt (success + fail) with txnId

### D4.3 — Yield Optimiser (own position)
- [ ] `src/defi/strategies/folksYield.ts` — manages agent's own Folks Finance deposit:
      - Deposits idle USDC into Folks Finance supply pool to earn interest
      - Withdraws when balance needed for other mandate activity
      - Target: never leave more than mandate daily cap idle — rest earns yield
- [ ] Dashboard: shows current APY, accrued interest, utilisation rate

### D4.4 — End-to-End Test
- [ ] Run liquidation monitor against mainnet — verify undercollateralised positions detected
- [ ] Execute one liquidation with test agent (small position)
- [ ] Verify bonus received, all steps atomic on Pera Explorer
- [ ] Test yield deposit: idle USDC deployed to Folks Finance supply, interest accruing

---

## Sprint D5 — Alpha Arcade Prediction Agent

**Why:** Alpha Arcade is the third-largest prediction market globally by daily transactions
(behind Polymarket and Kalshi). $50M+ total volume, launched Super Bowl 2025. All on
Algorand mainnet. Uses USDC (ASA 31566704 — same as our treasury). A mandate-gated agent
that participates in prediction markets is a direct wallet use case — the mandate daily cap
becomes a hard loss limit, making this the safest possible way to deploy a prediction strategy.

**Key reference:** `phara23/alpha-mcp` (GitHub) + `@alpha-arcade/mcp` (npm) — open-source
MCP server that wraps the full Alpha Arcade API. Use as the primary integration reference.
GoPlausible's `algorand-mcp` also integrates Alpha Arcade alongside Tinyman and x402 — worth
reviewing for approach and edge cases.

**Note on GoPlausible MCP:** GoPlausible has built a 125-tool Algorand MCP server that already
integrates x402, Alpha Arcade, and Tinyman. This is a potential competitor to our aggregator
MCP (Sprint 20). Their approach (OS keychain wallet, no custody) is fundamentally different
from ours (custodial, mandate-governed). Worth monitoring — our mandate governance and
on-chain audit trail are the differentiators.

### Mainnet Contract Details (confirmed)

| Parameter | Value |
|---|---|
| Matcher Application ID | `3078581851` |
| USDC Asset ID | `31566704` (same as our treasury) |
| ALPHA Token (governance/reward) | ASA `2726252423` |
| REST API | `https://platform.alphaarcade.com/api` |
| WebSocket API | `wss://wss.platform.alphaarcade.com` |
| API Key (optional) | From alphaarcade.com Partners tab — unlocks richer data + liquidity rewards |

### Alpha Arcade Tool Reference (from alpha-mcp)

**Read-only (no key required):**
- `get_live_markets` — all active prediction markets
- `get_market(marketId)` — specific market: odds, close time, volume, description
- `get_orderbook(marketId)` — current bid/ask orderbook
- `get_full_orderbook(marketId)` — complete on-chain orderbook depth
- `get_open_orders(walletAddress)` — agent's open orders
- `get_positions(walletAddress)` — agent's current YES/NO token holdings + unrealised P&L

**Trading (requires ALPHA_MNEMONIC / our signer):**
- `create_limit_order(marketId, side, price, quantity)` — sits on orderbook
- `create_market_order(marketId, side, quantity)` — immediate fill at best available price
- `cancel_order(orderId)` — cancel open order
- `amend_order(orderId, newPrice, newQty)` — modify open order
- `split_shares(marketId, usdcAmount)` — split USDC into YES + NO tokens at 1:1 ratio
- `merge_shares(marketId, shareAmount)` — merge YES + NO back into USDC
- `claim(marketId)` — collect winnings after market settles

**Streaming (WebSocket):**
- `stream_orderbook(marketId)` — real-time orderbook updates
- `stream_live_markets` — real-time market list
- `stream_wallet_orders(walletAddress)` — real-time order status for agent wallet

**Unit standards (all values in microunits):**
- Price: 500,000 = $0.50 | 1,000,000 = $1.00
- Quantity: 1,000,000 = 1 share
- Slippage: 50,000 = $0.05

### D5.1 — Alpha Arcade API Client
- [ ] `src/defi/alphaarcade/client.ts` — wraps `platform.alphaarcade.com/api`:
      - `getLiveMarkets()` → active markets with odds, volume, close time
      - `getOrderbook(marketId)` → bid/ask depth
      - `getPositions(agentAddress)` → open positions + unrealised P&L
      - `getOpenOrders(agentAddress)` → pending orders
- [ ] `src/defi/alphaarcade/builder.ts` — unsigned transaction constructors:
      - `buildLimitOrder(marketId, side, price, qty)` → app call to `3078581851`
      - `buildMarketOrder(marketId, side, qty)` → immediate fill app call
      - `buildSplitShares(marketId, usdcAmount)` → USDC → YES + NO tokens
      - `buildClaim(marketId)` → collect settled market winnings
- [ ] Optional: set `ALPHA_API_KEY` in Railway env for richer data + liquidity rewards
- [ ] Add Alpha Arcade app ID `3078581851` to SIGNING_ARCHITECTURE.md known app IDs

### D5.2 — Prediction Strategy Config
- [ ] Dashboard strategy config for `/app/dashboard/{agentId}`:
      - Enable/disable Alpha Arcade trading
      - Max bet size per market (USDC) — hard-limited by mandate per-tx cap
      - Daily loss limit — hard-limited by mandate daily cap
      - Strategy mode: **Manual** (agent only acts on explicit dashboard signal) or
        **Momentum** (agent follows orderbook imbalance above configurable threshold)
- [ ] Manual signal mode: human sends a signal from dashboard ("bet YES on market X at $0.10")
      — agent executes within mandate, logs result
- [ ] Position dashboard: open markets, YES/NO balances, unrealised P&L, settled + claimed history
- [ ] Auto-claim: agent automatically calls `claim` on settled markets the agent holds tokens in

### D5.3 — End-to-End Test
- [ ] Fund test agent with $5 USDC
- [ ] Configure: $0.25 max bet, $1.00 daily cap, manual mode
- [ ] Send manual signal from dashboard → agent places limit order on a live market
- [ ] Verify: order visible in orderbook, transaction on Pera Explorer
- [ ] Let market settle → verify `claim` fires automatically, USDC returned to agent wallet
- [ ] Verify all steps in dashboard transaction history with txnIds

---

## Phase 3 Milestone — Autonomous Algorand DeFi

The DeFi layer is live when an agent can run the following without any human transaction approvals:

- [ ] Agent holds ALGO + USDC, earns yield on idle USDC via Folks Finance
- [ ] Agent monitors Tinyman/Pact price feeds, executes arbitrage when opportunity > 0.2% profit
- [ ] Agent rebalances Lofty property portfolio weekly based on yield performance
- [ ] Agent auto-liquidates undercollateralised Folks Finance positions for bonus
- [ ] All transactions within mandate caps — human set rules once, agent operates indefinitely
- [ ] All activity visible in dashboard history with on-chain txnIds
- [ ] Guardian alerts fire on Telegram if position health deteriorates

---

## Phase 2 Milestone — The Full Loop

The ecosystem is live when all of the following work in a single uninterrupted flow:

- [ ] Human creates agent, sets mandate ($1/tx, $10/day)
- [ ] Agent wallet auto-topped with ALGO by gas station (no human action)
- [ ] User asks Claude: *"What's the weather in Lagos and the ALGO price?"*
- [ ] Claude calls aggregator MCP → discovers `get_weather` + `get_crypto_price`
- [ ] Two x402 payments fire: $0.001 + $0.001 USDC from agent wallet
- [ ] Both within mandate → both settle on-chain
- [ ] Claude answers with real data
- [ ] Human sees both transactions in dashboard history
- [ ] Total cost: $0.002 USDC + ~$0.0004 ALGO in fees

---

# Completed

## Security & Infrastructure
- [x] Treasury outflow guard (daily ALGO/USDC signing cap, auto-halt on breach)
- [x] Wallet guardian: velocity drain detection, Redis-backed halt
- [x] Wallet guardian: Rocca signer auth-addr rekey detection
- [x] HSM adapter pattern (Vault Transit / env mnemonic)
- [x] Recipient anomaly detector
- [x] Cold wallet SHA-256 hash anchoring in Redis
- [x] On-chain monitor (Indexer reconciliation vs Gate 5 authorized totals)
- [x] Gas station security hardening — all 6 vulnerabilities patched
- [x] Public test reports sanitized

## Performance
- [x] Redis migration: Upstash HTTP → Railway internal TCP (ioredis shim)
- [x] Auth-addr cache in validation (5-min TTL, eager invalidation on suspend)
- [x] Nodely primary/fallback failover with alert + recovery probe
- [x] p95 enqueue 1527ms

## Customer Dashboard (Sprints 2, 12)
- [x] 4-step agent creation wizard at `/app/create`
- [x] `/app/login` — Liquid Auth QR + WebAuthn dual-path
- [x] `/app/dashboard` — agent status, wallet QR sidebar, balance auto-poll, mandate summary, recent txns
- [x] `/app/mandates` — full mandate management with WebAuthn/Liquid Auth gate per action
- [x] `/app/history` — paginated transaction history with filters + search
- [x] Mandate double-parse bug fixed (listMandates was silently dropping all mandates)
- [x] Mandate ZADD float error fixed (Number.MAX_SAFE_INTEGER → valid score)
- [x] Revoked mandates returned and counted via `?includeRevoked=true` query param
- [x] Agent Status card: auth methods registered, signing type, network badge, status description
- [x] Cohort field removed from customer dashboard (internal infra concept, irrelevant to users)
- [x] Wallet address fixed — uses `agent.address` not synthetic `webauthn:...` identifier
- [x] Mandate expiry required — past dates unselectable in date picker

## SDK & Integrations
- [x] `@algo-wallet/x402-client@0.2.0` built (publish to npm pending)
- [x] `@algo-wallet/x402-mcp@0.1.0` MCP server built (publish pending)
- [x] `algo-x402@0.1.0` Python SDK built (publish pending)
- [x] `@algo-wallet/x402-cli@0.1.0` CLI built (publish pending)
- [x] API versioning: `/v1/api/*` canonical, `/api/*` legacy alias

## Payment Stress Testing (Sprint 5)
- [x] Burst: 5/5 concurrent, p95 enqueue 1461ms
- [x] Sustained: 50/50 over 17.2 min, 0 failures
- [x] Velocity cap: fires correctly, idempotent on retry
- [x] Nodely failover: activates in ~44s, auto-recovery
- [x] Redis failure: boot-time FATAL — fail-closed (502)
- ⚠ NOTE: Sprint 5 ran with local Cohort A signer (`2FBKPEID...`), not the current Railway
  production signer (`6RZV6XEP6...`). Results are mechanically valid but not a confirmed
  test of the current production signing configuration. Re-run planned in Sprint 16A.2.

## End-to-End Payment Test (Sprint 16)
- [x] `POST /api/weather` — x402-gated, Open-Meteo geocoding + current conditions
- [x] `scripts/buy-weather.ts` — full 402 bounce + proof + sandbox + job poll flow
- [x] Txn confirmed mainnet round 59,427,810: `SJU6VBOOWLQ5X7YM2F22LGOVSC6QNIPRT5K4ACGTVJJ5RZDONIBQ`
- [x] `weather-test-agent` — registered and rekeyed to prod signer, 20,000 µUSDC funded
- ⚠ Six structural issues found — tracked in Sprint 16A
