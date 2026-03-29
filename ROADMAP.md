# algo-wallet — Production Roadmap

> **Purpose:** Step-by-step execution plan covering infrastructure launch through ecosystem buildout.
> Revisit this file at the start of every session to pick up where we left off.
> Mark items `[x]` as they are completed.

---

## Vision

**The core truth:** A non-custodial AI agent governed by an on-chain AVM mandate contract.
The human sets limits once via their master wallet. The AVM enforces every payment atomically.
No server-side signing. No trusted intermediary. The chain is the truth.

**The payment rail:** x402 over Algorand USDC. Agents pay APIs natively.
~$0.0002/txn. 3.8s finality. Immediate confirmation.

**The distribution layer:** AP2 (Google's Agent Payments Protocol) as a thin translation
adapter. AVM mandates are the enforcement. AP2 is how agents built on other frameworks
find and pay through this rail. AP2 does not drive architecture — the AVM contract does.

```
Human (master wallet)
    │  deploys MandateContract once
    │  sets: per-tx cap, velocity, daily cap, whitelist
    ↓
MandateContract (Algorand AVM) ← the truth. code is law.
    │  enforces all gates atomically on every pay() call
    │  inner txns: USDC to recipient + toll to treasury
    ↓
AI Agent (own Ed25519 key, non-custodial)
    │  signs MandateContract.pay() app calls autonomously
    │  speaks x402 natively
    │  optionally wraps in AP2 semantics for cross-framework agents
    ↓
x402 payment rail  ──────────────────────────────────────────────────────────┐
    │                                                                         │
    ├── API Registry / MCP Aggregator (Sprints 19–20)                        │
    │       Claude / Gemini / any LLM discovers tools → pays → gets data     │
    │                                                                         │
    └── AP2 adapter (Sprint Q — thin layer, not architecture)                │
            Any AP2-compatible agent settles here via algorand-usdc-x402 ────┘
```

**Phase 1 — Infrastructure** *(complete)*
AVM mandate contracts written. x402 settlement middleware updated. Client SDK updated.
Sprint O remaining work: deploy contracts, update paywall, migrate agent registration.

**Phase 2 — Ecosystem** *(current)*
Seller SDK → API Registry → Aggregator MCP. Build the supply side. Let agents find and
pay for APIs autonomously. AP2 adapter added small — as distribution, not architecture.

---

## Current State (after Sprint O — On-Chain Mandate Architecture)

- Railway backend live: `https://api.ai-agentic-wallet.com`
- Vercel frontend live: `https://ai-agentic-wallet.com`
- Redis internal TCP active — p95 enqueue 1.53s, avg ~1.25s
- Auth-addr cache (5-min TTL) eliminates algod round-trips
- Nodely failover active (primary → fallback + recovery probe)
- SDK `@algo-wallet/x402-client@0.3.0` — **published to npm ✅** (Sprint 16A: `client.fetch()`, `parseGasInfo`, proof format fix)
- MCP server `@algo-wallet/x402-mcp@0.2.0` — **published to npm ✅** (3 tools: pay, balance, mandates; signature bug fixed)
- Python SDK `algo-x402@0.1.0` — **published to PyPI ✅**
- CLI `@algo-wallet/x402-cli@0.1.0` — **published to npm ✅**
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
- **On-chain mandate contracts written** — PyTEAL MandateFactory + MandateContract + server verifier + updated client (Sprint O, NOT yet deployed)

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
- [x] Publish: `@algo-wallet/x402-cli` to npm

---

## Sprint 15 — Publish SDKs *(planned)*

- [x] Publish MCP server: `npm publish --access public` from `packages/x402-mcp/`
- [x] Publish Python SDK: `python -m build && twine upload dist/*` from `packages/algo-x402/`
- [x] Update `DOCS_FOR_AGENTS.md` with published package names + install commands
- [x] Update `/docs` page with MCP install instructions

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
- [x] `/health` returns fully green across all subsystems

---

# PHASE 2 — Ecosystem (The Marketplace)

> **The defensible core:** x402 + AVM mandate contracts. Non-custodial. On-chain enforcement.
> Agent holds its own key. Nobody else built this on Algorand.
>
> **Phase 2 builds the supply side:** sellers list APIs, agents discover and pay autonomously.
> Claude and other LLMs do the matching through MCP tool discovery.
>
> **AP2 is distribution, not architecture.** A thin adapter lets agents built on Google ADK,
> LangChain, AutoGen — anything that speaks AP2 — settle payments here via `algorand-usdc-x402`.
> The AVM contract does not change to accommodate AP2. AP2 adapts to the AVM.
>
> **Why Algorand beats EVM here:** ~$0.0002/txn vs $0.05–$5.00. 3.8s finality vs 12–60s.
> Immediate confirmation. No gas auctions. Micropayments are economically viable.

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

### 16A.1 — Fix Payment Atomicity (Critical) ✅

**Fix — Inline settlement middleware (`x402Settle`):**

New middleware `src/middleware/x402Settle.ts` runs after `x402Paywall` in the chain.
It executes the USDC toll payment (sign → enqueue) **before** the route handler delivers
any data. Gate sequence: agent lookup → halt check → circuit breaker → rate limits →
velocity check → constructAtomicGroup → executePipeline → circuit breaker feedback.
On any failure the middleware responds 503 and does NOT call `next()` — data is never leaked.

- [x] `src/middleware/x402Settle.ts` — new inline settlement middleware
- [x] `src/middleware/x402.ts` — `req.x402` type extended with `settlementJobId`, `settlementAgentId`
- [x] `POST /api/weather` — middleware chain is now `x402Paywall, x402Settle`; handler drops sandbox,
      returns `{ weather, jobId, agentId, pollUrl, toll_micro_usdc, status: "settled" }`
- [x] `scripts/buy-weather.ts` — simplified to 3 steps: health → buy (atomic) → poll confirmation;
      `AGENT_ID` env var no longer required (resolved server-side from senderAddr)
- [x] `tsc --noEmit` passes clean
- [x] `tests/x402Settle.adversarial.test.ts` — 5 tests: missing context → 500, unregistered → 402,
      suspended gate present, next() invariant (all non-Redis-dependent gates); 5/5 pass

---

### 16A.2 — Unify Signer Keys: Dev = Prod ✅

**Problem:** Two different signer keys exist in the same codebase:

| Context | `ALGO_SIGNER_MNEMONIC` derives to | Role |
|---|---|---|
| Local `.env` | `2FBKPEID...` | Cohort A / dev signer |
| Railway production | `6RZV6XEP6...` | Production signer |

Agents registered locally (speed-test-agent) are rekeyed to the dev signer, making them
incompatible with the production server. Sprint 5 stress test results may not reflect
current production behaviour since the environment has drifted.

**Decision:** Keep dev and prod signers separate. Fix detection instead of copying prod key locally.

- [x] `assertSignerAddressMatch()` added to `src/protection/envGuard.ts` — derives address
      from `ALGO_SIGNER_MNEMONIC`, compares against `ALGO_SIGNER_ADDRESS`, throws on mismatch
      with clear remediation message. Called in signing service boot sequence.
- [x] Re-register speed-test-agent against the production signer — superseded by `weather-test-agent` (already rekeyed to prod signer, stress tests re-run 2026-03-24)
- [x] Re-run Sprint 5 stress test against current production configuration
      (ran 2026-03-24 with `weather-test-agent` rekeyed to prod signer — 5/5 queued, p95 enqueue 2346ms, 5/5 confirmed)

---

### 16A.3 — Fix X-PAYMENT Proof for Rekeyed Agents ✅

**Problem:** `requestWithPayment` in the client interceptor builds a USDC transfer signed by
`privateKey` — the agent's original key. For rekeyed agents, this signature is invalid on
Algorand (requires the auth-addr's key). `x402Paywall` only checks the ed25519 signature over
the groupId, not whether the embedded transaction would pass Algorand validation. So the proof
passes middleware verification, but if the signed transaction were ever submitted on-chain it
would be rejected.

**Fix applied — Option A (temporary workaround):**

- [x] `transactions` field removed from `buildPaymentProof` return in `packages/x402-client/src/interceptor.ts`
      — txn is still built internally to derive the `groupId`, but signed bytes are not included in the proof
- [x] `X402PaymentProof.transactions` made optional in `packages/x402-client/src/types.ts` with JSDoc explanation
- [x] `src/middleware/x402.ts` — `parsePaymentHeader` accepts absent/empty transactions;
      `verifyGroupIntegrity` skips when transactions absent; error message updated
- [x] Proof format is now `{ groupId, senderAddr, signature, timestamp, nonce }` — clean identity proof,
      no embedded on-chain-invalid transaction bytes

> **Note:** Option A is a structural workaround, not a true x402 fix. The X-PAYMENT header still
> does not contain a valid submittable transaction. The permanent solution is Sprint O (on-chain
> mandate contracts) where agents sign real `ApplicationCallTxn` bytes and the server submits them as-is.

---

### 16A.4 — Make SDK Client URL-Generic ✅

**Problem:** `AlgoAgentClient.requestSandboxExport()` is hardcoded to `/api/agent-action`.
Any new x402-gated endpoint (weather, news, FX, crypto price) requires importing
`requestWithPayment` directly from the interceptor — a lower-level internal not part of the
public API contract.

- [x] `AlgoAgentClient.fetch(path, init?)` added to `packages/x402-client/src/client.ts`
      — absorbs 402 on any x402-gated endpoint, returns raw `Response`
- [x] `parseGasInfo` and `AgentGasInfo`/`AgentGasStatus` exported from package public index
- [x] `scripts/buy-weather.ts` — uses `AlgoAgentClient` + `client.fetch("/api/weather", {...})`
      instead of importing `requestWithPayment` from the interceptor directly
- [x] `DOCS_FOR_AGENTS.md` section 3b — custom x402 endpoint example with `client.fetch()`,
      job polling pattern, and payment atomicity guarantee note

---

### 16A.5 — Add `verify-env.ts` Sanity Check Script ✅

**Problem:** `railway variables` truncates long values in its display output (showed 40 chars
of a 64-char `PORTAL_API_SECRET`). Spent a full debugging cycle on a non-existent auth failure.
No tooling exists to diff local `.env` against Railway production config.

- [x] `scripts/verify-env.ts` — diffs local vs Railway for 6 critical vars:
      `ALGO_SIGNER_ADDRESS`, `X402_PAY_TO_ADDRESS`, `ROCCA_SIGNER_ADDRESS`,
      `UPSTASH_REDIS_REST_URL`, `PORTAL_API_SECRET` (length+prefix only),
      `ALGO_SIGNER_MNEMONIC` (derived address only — never logs raw mnemonic)
- [x] `"verify-env": "npx tsx scripts/verify-env.ts"` added to `package.json`
- Run `npm run verify-env` before debugging auth or signing failures

---

### 16A.6 — Harden Agent Registration Flow ✅

**Problem:** `setup-sprint16-agent.ts` has hardcoded addresses, hardcoded mnemonics, and is a
one-off throwaway script. The real problem it solved (registering a test agent against the
production signer) should be a proper reusable utility.

**Decision:** Funding automation is over-engineering for a rarely-used script. Keep it minimal.

- [x] Deleted `scripts/setup-sprint16-agent.ts` (hardcoded addresses/mnemonics)
- [x] `scripts/register-agent.ts` — generates fresh keypair, prints address + mnemonic,
      gives manual funding instructions; `--register` flag calls `/api/agents/register-existing`
      Usage: `npx tsx scripts/register-agent.ts --agent-id my-agent [--register]`

---

### 16A.7 — Fix buy-weather.ts Banner Formatting ✅

**Problem:** The banner columns are misaligned for several fields due to fixed-width padding
not accounting for URL length variance.

- [x] Banner rewritten with `row()` helper — consistent alignment regardless of URL length
- [x] `CITY`, `AGENT_ID`, `ALGO_MNEMONIC` added to `.env.example` under test scripts section

---

### 16A.8 — Mandate Security Hardening ✅

**Problem (critical):** Mandates were caller-presented and opt-in. An agent could bypass its
owner-configured spend limits on two separate attack vectors:

1. `/api/execute` — omit `mandateId` entirely; request falls to the global velocity path
   ($50/10min) instead of the mandate's tighter caps.
2. `x402Settle` (fixed-toll endpoints) — mandate rolling windows never consulted; toll
   payments did not count against the mandate's daily/10min budget.

**Why it mattered:** The product guarantee is that mandates define the agent's total blast
radius. If an agent could route around mandates, the owner's configured limits were illusory.

**Fixes applied:**

- [x] `src/services/mandateEngine.ts` — `enforceActiveMandate(agentId, amountMicroUsdc)`:
      loads all active mandates for the agent, derives the tightest caps across all of them
      (maxPerTx, maxPer10Min, maxPerDay), and runs the amount through the shared mandate
      velocity Lua script atomically. Returns `{ hadMandate: false }` when no mandates exist
      so the caller can fall back to global velocity. Fail-closed on Redis outage.
- [x] `src/services/mandateEngine.ts` — `rollbackMandateVelocity(agentId, reservationKey)`:
      ZREM rollback for mandate velocity windows on pipeline failure — mirrors
      `rollbackVelocityReservation` in velocityEngine.
- [x] `src/middleware/x402Settle.ts` — Gate 5 split: agents WITH active mandates route
      through `enforceActiveMandate` (mandate velocity, fail-closed); agents WITHOUT mandates
      use existing global velocity path (fail-open). Toll payments now count against the
      mandate's rolling budget — same Redis windows as `/api/execute` mandate evaluations.
- [x] `src/middleware/x402Settle.ts` — `releaseLock()` updated to roll back either mandate
      or global velocity reservation depending on which path was used.
- [x] `src/index.ts` — `/api/execute`: if `mandateId` absent AND agent has active mandates →
      reject `403 MANDATE_REQUIRED`. Agent cannot sidestep mandate by omitting the field.
      Falls through to velocity path only when agent has no mandates at all.

**Additional x402Settle improvements (same session):**
- [x] `src/middleware/x402Settle.ts` — Gate 6: per-agent concurrent-settlement lock
      (`x402:settling:{agentId}` SET NX EX 15) prevents burst double-pay. Two concurrent
      requests with different nonces both pass replay guard — lock ensures only one settles.
      Returns `429 CONCURRENT_SETTLEMENT` with `Retry-After: 1` to the second request.
- [x] `src/middleware/x402Settle.ts` — Gas advisory headers (`X-Agent-Gas-Status`,
      `X-Agent-Gas-Remaining`) added before `next()` — SDK `parseGasInfo()` now works on
      fixed-toll endpoint responses.
- [x] `src/middleware/x402Settle.ts` — Pipeline failure now returns `502` (was `503`) to
      match `/api/execute` behaviour. `failedStage` included in body.
- [x] `src/middleware/x402Settle.ts` — JSDoc updated: mandate bypass intentional on this path
      (toll is flat fee, mandates govern agent-scoped spend) now documented explicitly.

---

**Completion criteria for 16A:** `buy-weather.ts` runs end-to-end with USDC moving atomically
*as a precondition* to data delivery, local and production signers are aligned, and `npm run
verify-env` passes clean.

---

## Sprint 17 — MCP Discoverability ✅

**Why:** GoPlausible's algorand-mcp dominates Algorand MCP listings (7 registries, 100 tools).
Competing on breadth is a losing strategy. The niche nobody owns: mandate-governed autonomous
agent spending — human-set limits, on-chain audit trail, fail-closed safety. Sprint 17 owns
that search intent and gets the MCP server in front of the right users.

**Niche positioning:** "The safety layer for autonomous AI agent spending on Algorand.
Your owner sets limits. The agent operates within them. Every payment is on-chain."

### 17.1 — MCP Server: 3 Tools + Fixed Signature Bug ✅
- [x] `pay_with_x402` — rewritten description: mandate-first, removed cross-chain noise,
      now takes `endpoint` param (any x402-gated URL, not hardcoded to agent-action)
- [x] `check_balance` — new: USDC + ALGO balance from indexer, gas status + remaining txns
- [x] `check_mandates` — new: list active mandates with per-tx/daily caps + expiry
- [x] **Bug fixed:** proof was signing `groupId:timestamp:nonce` but server verifies
      signature over groupId bytes only — payments would have failed in production
- [x] Removed `transactions` field from proof (Sprint 16A.3 fix, was missing from MCP)
- [x] Published `@algo-wallet/x402-mcp@0.2.0` to npm ✅

### 17.2 — Smithery Listing ✅
- [x] `packages/x402-mcp/smithery.yaml` — auto-configures server in Claude Desktop
      with guided env var setup (ALGO_MNEMONIC, X402_AGENT_ID, X402_PORTAL_KEY)
- [ ] Submit to Smithery — **blocked: requires hosted HTTP endpoint** (Smithery publish only accepts remote HTTP servers, not stdio/npx). Deferred to Sprint 18 when HTTP transport is added.

### 17.3 — mcp.so Listing
- [x] Submit via GitHub issue: https://github.com/chatmcp/mcpso/issues/1330 ✓

### 17.4 — Spec doc (deferred to Sprint 18)
Discovery headers + `.well-known/x402` are useful for Sprint 18 seller SDK — deferred.

### 17.5 — Public MCP repo + Registry Submissions *(todo)*

**Why keep main repo private:** source exposes full security architecture (gate order,
velocity thresholds, Redis key prefixes, signing flow) — gives attackers a meaningful
head start. Keep private.

**Approach:** create a separate minimal public repo with zero source code:

- [x] Create `github.com/m-reynaldo35/x402-mcp` with 3 files (smithery.yaml, package.json, README.md) ✓
- [ ] Submit to Smithery — blocked: requires hosted HTTP endpoint (deferred to Sprint 18)
- [x] Submit to mcp.so via GitHub issue — https://github.com/chatmcp/mcpso/issues/1330 ✓

---

---

## Sprint O — On-Chain Mandate Architecture *(in progress — contracts written, not yet deployed)*

**Why:** The existing architecture is not true x402. Under the Rocca rekey model:
- `X-PAYMENT` contains a phantom USDC transfer signed by the agent's original key (invalid on-chain for rekeyed accounts)
- The server builds and signs every payment transaction server-side using one shared Rocca key
- Mandate enforcement lives in Redis — not in the transaction itself
- The agent does not hold its own signing key (non-self-sovereign)

**The fix — on-chain AVM mandates:**
- Each agent gets a `MandateContract` (stateful Algorand app) deployed via `MandateFactory`
- Agent holds its own Ed25519 key — signs application calls directly (non-custodial)
- `X-PAYMENT` = base64-encoded signed `MandateContract.pay()` app call — a real submittable transaction
- The AVM enforces all mandate gates: per-tx cap, 10-min velocity window, 24h daily cap, recipient whitelist, halt flag
- Server responsibility: decode + verify provenance + submit. No signing. No construction.
- Toll (0.01 USDC) fires as an inner transaction on every pay() call — cannot be bypassed

```
Agent (own key)
    │ signs MandateContract.pay(treasury, 10000)
    ↓
X-PAYMENT header  →  Server: decode + verify factory provenance + submit
                                      ↓
                             AVM enforces mandate gates atomically
                                      ↓
                  inner txn: treasury +10000 µUSDC (toll only, no double-toll)
```

---

### O.1 — PyTEAL Contracts ✅

- [x] `contracts/pyteal/constants.py` — all state keys (short: `ak`, `mw`, `tr`, `fi`, etc.), schema counts, network constants (USDC IDs, time windows)
- [x] `contracts/pyteal/mandate_contract.py` — stateful per-agent MandateContract:
      - `pay(address, uint64)` — 6 gates: halt check → agent identity → non-zero → per-tx cap → velocity window → daily cap → inner txns
      - Recipient whitelist via box storage (32-byte address as box key)
      - `Global.latest_timestamp()` for real wall-clock velocity windows (not round-based)
      - Treasury payments skip double-toll: single inner txn when `recipient == treasury`
      - Seller payments fire 2 inner txns: payment + toll atomically
      - `update_mandate(max, vel, daily, version)` — master wallet only + anti-rollback version counter
      - `add_recipient(addr)` / `remove_recipient(addr)` — box whitelist management
      - `halt()` / `resume()` — emergency controls by master wallet
      - `transfer_master(addr)` — transfer mandate authority
      - `opt_in_usdc()` — app account opts in to USDC ASA
- [x] `contracts/pyteal/mandate_factory.py` — operator-deployed factory:
      - `set_programs(approval_bytes, clear_bytes)` — store compiled contract in boxes
      - `create_agent(agent_key, master, max_per_tx, vel_cap, daily_cap)` — inner app-create, returns new app ID via log
      - Treasury, toll, usdc_id taken from factory state — caller cannot override
      - `factory_id` written into every child contract → provenance chain
      - `update_toll()` / `update_treasury()` — affects new contracts only
      - `pause()` / `unpause()` — block new deployments
- [x] `contracts/pyteal/deploy.py` — deployment CLI:
      - `python deploy.py deploy-factory` — one-time operator setup, prints `FACTORY_APP_ID`
      - `python deploy.py set-programs` — upload compiled bytes to factory boxes, prints `MANDATE_CONTRACT_APPROVAL_HASH`
      - `python deploy.py create-agent --agent-key X --master-key Y --max-per-tx N --velocity N --daily N`
- [x] `contracts/pyteal/requirements.txt` — pyteal, algosdk, algokit-utils

### O.2 — Server-Side Mandate Verifier ✅

- [x] `src/services/mandateVerifier.ts` — `verifyMandateCall(signedTxnBase64)`:
      - Decodes signed transaction (msgpack → algosdk.SignedTransaction)
      - Verifies `type == appl`
      - Verifies ARC-4 method selector == `pay(address,uint64)void`
      - Decodes ABI args: recipient (32 bytes → address), amount (uint64 big-endian)
      - Verifies toll parameters when `recipient == treasury`
      - `checkFactoryProvenance(appId)`: reads `global-state["fi"]` from algod, compares against `MANDATE_FACTORY_APP_ID`
      - Redis cache (1hr TTL) for provenance — avoids algod call on every request
      - Fallback: SHA-256 hash of approval program when factory ID not set
      - Returns `VerifiedMandateCall` with `appId`, `appAddress`, `agentAddress`, `recipient`, `amountMicroUsdc`

### O.3 — Updated Settlement Middleware ✅

- [x] `src/middleware/x402Settle.ts` — replaced construct-sign-submit pipeline with decode-verify-submit:
      - Gates 5 (velocity), 7 (constructAtomicGroup), 8 (executePipeline) **removed**
      - New Gate 5: `verifyMandateCall()` — ARC-4 selector + toll params + factory provenance
      - New Gate 6: sender match — `appCall.sender == registered agent address`
      - New Gate 7: per-agent concurrent-settlement lock (SETTLING_LOCK_TTL_S = 30s)
      - New Gate 8: `algod.sendRawTransaction(signedBytes)` + `algosdk.waitForConfirmation(txid, 5)`
      - AVM rejections → 402 with mandate error message
      - Network errors → 502 + circuit breaker record
      - Gas advisory headers now report MandateContract app account balance (not agent wallet)
      - `X-Agent-Contract-Id` header added
      - Removed: `constructAtomicGroup`, `executePipeline`, `enforceActiveMandate`, `rollbackMandateVelocity`, velocity reservation rollback
      - `tsc --noEmit` passes clean

### O.4 — Updated Client SDK ✅

- [x] `packages/x402-client/src/interceptor.ts` — `buildMandatePayCall()` replaces phantom groupId builder:
      - Builds real `ApplicationCallTxn` targeting `mandateAppId`
      - ARC-4 args: `[PAY_SELECTOR, treasuryBytes(32), amountBuf(8)]`
      - `fee = 3_000 µALGO` (covers outer + 2 inner transactions), `flatFee = true`
      - Signs with agent's own key (`txn.signTxn(privateKey)`)
      - Returns base64(msgpack(SignedTransaction)) — raw Algorand bytes, not JSON
      - `requestWithPayment` now requires `mandateAppId: number` parameter
      - `parseGasInfo` updated: reads `X-Agent-Contract-Id` header, returns `contractId` field
      - 402 on retry classified as `POLICY_BREACH` (mandate gate fired)
- [x] `.env.example` — added `MANDATE_FACTORY_APP_ID`, `MANDATE_CONTRACT_APPROVAL_HASH`, `MANDATE_APP_ID`

---

### O.5 — COMPLETE *(mainnet deploy 2026-03-29, E2E test PASSED)*

**Contract fix (do first):**
- [x] **Whitelist-optional mode** — `mandate_contract.py` Gate 4 updated: explicit `whitelist_enabled`
      global state bool (`KEY_WHITELIST_ENABLED = b"we"`, default 0 = open). Gate 4 only fires when
      `we == 1 AND recipient != treasury`. `enable_whitelist()` / `disable_whitelist()` ARC-4 methods
      added (master wallet only). Schema bumped to 12 uint64. Open mode allows any recipient; strict
      mode enforces box whitelist. Toggle cleanly without touching box storage.

**Server wiring:**
- [x] **Invert provenance check in `src/services/mandateVerifier.ts`** — SHA-256 hash is now
      primary; `factory_id` global state is optional secondary (belt-and-braces only). `MANDATE_CONTRACT_APPROVAL_HASH`
      is required; `MANDATE_FACTORY_APP_ID` is optional. If hash passes but factory_id mismatches,
      reject with warning (correct bytecode, wrong factory lineage = suspicious). Single algod call
      now fetches both `approval-program` and `global-state` together.
- [x] **Tighten validity window in `packages/x402-client/src/interceptor.ts`** — `sp.lastValid =
      sp.firstValid + 15n` (~53s window). Algorand's default ~1000 rounds was too wide.
- [x] **Simplify `replayGuard.ts`** — mandate-format payments already never called `replayGuard`
      (x402.ts only calls it for legacy JSON path). Validity window tightened (above) closes the
      replay surface. Legacy JSON path preserved for backward compat with any remaining Rocca agents.
- [x] **Update `src/middleware/x402.ts`** — already handling mandate format: decodes SignedTransaction,
      extracts `senderAddr` from `txn.sender`, passes to x402Settle. No change needed.
- [x] **Audit `src/middleware/validation.ts`** — Rule 3 (`authAddr` / Rocca rekey check) removed.
      Rule 1 (toll check) wrapped in `if (routing.authAddr)` — skipped for mandate agents whose toll
      was already paid by the MandateContract inner txn. Rule 2 (signer match) unchanged. Unused
      imports (`getAlgodClient`, `getRedis`, `AUTH_ADDR_CACHE_TTL_S`) removed. `tsc --noEmit` clean.
- [x] **Agent registration** — `POST /api/agents/create-mandate` (new endpoint) calls
      `MandateFactory.create_agent()` via `src/services/mandateFactory.ts`. Operator wallet is set
      as master wallet → server can call `opt_in_usdc()` automatically. Returns `{mandateAppId,
      appAddress, deployTxid}`. Activation poller detects ALGO deposit → calls `callOptInUsdc()` →
      user sends USDC → agent goes active. `mandateOperatorMaster: boolean` added to `AgentRecord`.
- [x] **Agent registry schema** — `mandateAppId?: number` already in `AgentRecord`. Parallel support
      for old Rocca-rekeyed agents until migrated.

**SDK + tooling:**
- [x] **`packages/x402-client/src/client.ts`** — `mandateAppId` already in `ClientConfig` (required field).
- [ ] **`packages/x402-mcp/`** — `pay_with_x402` tool uses new `mandateAppId`-based signing.
- [ ] **`packages/x402-cli/`** — `mandate list` shows contract app ID + on-chain velocity state.

**Dashboard:**
- [ ] **Onboarding wizard** — Step 3: agent no longer rekeys to Rocca. Activation deposits
      ALGO + USDC to MandateContract app account. Show app account address + QR.

**Deploy + verify:**
- [ ] **Deploy to testnet** — `contracts/pyteal/deploy-testnet.sh` (one-shot script).
      Prereq: fund operator account `R7JGMAOPVNMYDRO4QSKGE4VEU66LDW34TKXPD6DFFJTDDXUOAJCCBGJMLM`
      with ≥2 testnet ALGO from https://bank.testnet.algorand.network/ then:
      `export OPERATOR_MNEMONIC="<mnemonic>" && bash contracts/pyteal/deploy-testnet.sh`
- [x] **End-to-end test** — `scripts/buy-weather.ts` PASSED on mainnet (2026-03-29).
      Txn: `UICORLIHADYOKU6LJCYFYBZGHUU2EE76ZF7MTGLQQK2YQHOZXF7Q`
      Lagos 28°C, toll 10,000 µUSDC confirmed on-chain.
- [x] **Set env vars** — `MANDATE_CONTRACT_APPROVAL_HASH` + `MANDATE_FACTORY_APP_ID` + `OPERATOR_MNEMONIC`
      set in Railway production.
- [x] **Mainnet deploy** — Factory app_id=3498110794, operator-test-agent mandate app_id=3498117490.
      Real $0.01 USDC payment verified on Algorand mainnet.

**Post-O.5 tracked risks (not blockers, but must not be forgotten):**

- **Latency** — `x402Settle.ts` calls `waitForConfirmation(txid, 5)`, blocking ~3–18s per payment.
  For low-value ($0.01) high-frequency agent calls this may be acceptable; for interactive sessions
  it is not. After O.5 ships, prototype an optimistic settlement option: submit → algod accepted
  (not confirmed) → serve response with pending txid. AVM will confirm or reject; fee is burned on
  submit regardless. Make it opt-in per endpoint with a `x402-settle: optimistic` response header.

- **Contract update authority** — `mandate_contract.py` allows master wallet to call
  `UpdateApplication`, rewriting any agent's contract gates at will. This is undocumented. Add a
  clear statement to the `POST /api/agents/register-mandate` response and onboarding docs: the
  operator's master wallet retains upgrade authority over deployed contracts. Agents trust the
  operator. Long-term, consider time-locking updates (N-round advance notice enforced by TEAL).

- **Onboarding automation** — per-agent deployment is a 5-step Python CLI process requiring
  operator mnemonic. Create a single `scripts/create-mandate-agent.ts` that chains: factory
  create-agent → fund contract → opt_in_usdc → register-mandate. Self-service onboarding is
  required before Phase 2 seller SDK launch.

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

### 18.0 — HTTP Transport for MCP Server (unlocks Smithery listing) ✅
- [x] `src/mcp/httpServer.ts` — stateless StreamableHTTP transport, credentials via headers, same 3 tools as stdio server
- [x] `POST /mcp` mounted in `src/index.ts` — behind rateLimiter, no extra Railway service needed
- [x] CORS updated: X-Algo-Mnemonic, X-Agent-Id, X-Api-Url headers added
- [x] `smithery.yaml` updated: type http, url `https://api.ai-agentic-wallet.com/mcp`, headers mapped to config vars
- [x] Public repo `github.com/m-reynaldo35/x402-mcp` updated with new smithery.yaml
- [ ] Submit to Smithery: https://smithery.ai/new → point at `https://github.com/m-reynaldo35/x402-mcp` (deploy to Railway first)

### 18.2 Seller Documentation
- [ ] Quickstart: "Add x402 payment to your API in 5 minutes"
- [ ] Pricing guide: micro-USDC denomination, recommended price tiers
- [ ] Security guide: replay protection, mandate-aware rate limiting

---

## Sprint Q — AP2 Adapter *(small, after Sprint O mainnet + Sprint 18 complete)*

**Scope:** AP2 is a distribution channel, not an architecture driver. The AVM contract does
not change to accommodate AP2. AP2 adapts to the AVM. This is a thin translation layer only.

**What AP2 is:** Google's [Agent Payments Protocol](https://github.com/google-agentic-commerce/AP2).
Three-stage mandate chain: `IntentMandate` → `CartMandate` (merchant-signed) → `PaymentMandate`
(agent authorization). Framework-agnostic. Built on W3C Payment Request API + SD-JWT-VC.

**The boundary:** AP2 handles commerce semantics (what to buy, from whom). Our AVM handles
enforcement (caps, velocity, whitelist). AP2 mandate chain terminates in `MandateContract.pay()`.
The AVM is the truth. AP2 is how external agents find their way here.

**Architectural constraint:** Do not modify `mandate_contract.py` for AP2 compatibility.
Do not add JWT verification to the AVM. Do not make the AVM aware of AP2 concepts.
The adapter lives entirely outside the contract.

---

### Q.1 — Python Adapter (`packages/ap2-adapter/`)

AP2 types are Python/Pydantic — adapter lives in the Python layer.

- [ ] `ap2_algorand/payment_method.py` — `AlgorandUsdcMethodData(mandate_app_id, asset_id, network, x402_endpoint)` — the `algorand-usdc-x402` payment method data shape
- [ ] `ap2_algorand/cart_adapter.py` — `cart_to_payment_args(CartMandate) → (app_id, amount_micro_usdc, recipient)` — extracts and validates the x402 payment params from a CartMandate
- [ ] `ap2_algorand/settle.py` — `settle(CartMandate, private_key, algod_url) → PaymentReceipt`:
      builds `MandateContract.pay()` ARC-4 app call, signs with agent key, submits,
      returns AP2 `PaymentReceipt` with Algorand txid as all three confirmation ID fields
- [ ] `pyproject.toml` — deps: `ap2 @ git+https://github.com/google-agentic-commerce/AP2`, `py-algorand-sdk`, `pydantic`
- [ ] `README.md` — install + 10-line quickstart

### Q.2 — Sample Scenario + PR

The PR into `google-agentic-commerce/AP2` is the distribution play. Matches their sample structure exactly.

- [ ] `samples/ap2-algorand/run.sh` + `README.md` — runnable end-to-end:
      agent issues `IntentMandate` → our `/api/weather` returns `CartMandate` (payment_method: `algorand-usdc-x402`) → adapter fires `MandateContract.pay()` → `PaymentReceipt` with Pera Explorer link
- [ ] Open PR to `google-agentic-commerce/AP2` — add `algorand-usdc-x402` as a payment method sample
- [ ] `GET /.well-known/ap2` on Railway — discovery endpoint returning `mandate_factory_app_id`, `network`, `asset_id`

### Q.3 — Reference Mapping

| AP2 concept | Our equivalent |
|---|---|
| `IntentMandate` | Master wallet mandate config (caps set once at contract deploy) |
| `CartMandate` | x402 402-response (merchant's price offer) |
| `PaymentMandate` | Signed `MandateContract.pay()` app call |
| `user_cart_confirmation_required: false` | Autonomous mode — AVM caps are the consent boundary |
| `PaymentReceipt.network_confirmation_id` | Algorand txid — network IS the ledger |
| `merchant_authorization` JWT | Seller's Algorand address + factory provenance check |

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
- [x] `@algo-wallet/x402-client@0.3.0` published to npm ✅ (Sprint 16A: `client.fetch()`, `parseGasInfo`, proof format fix)
- [x] `@algo-wallet/x402-mcp@0.1.0` published to npm ✅
- [x] `algo-x402@0.1.0` Python SDK published to PyPI ✅
- [x] `@algo-wallet/x402-cli@0.1.0` published to npm ✅
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

## Sequential Payment Proof (Sprint 16A — 2026-03-24)
- [x] `scripts/run-100-payments.ts` — 100 sequential $0.01 USDC payments, all confirmed on Algorand mainnet
- [x] **100/100 confirmed**, $1.00 USDC spent, avg 6149ms, p95 8238ms, 0 failures
- [x] Full receipt log with all 100 txnIds and confirmed rounds — verifiable on Pera explorer
- [x] Agent: `ZBYZFOXJEKC6IBR47DEUF46QLNH7NOLJBYUPSDQDKH43PZUBQ7LGKHG4AQ`

## Burst / Concurrent Payment Test (Sprint 16A — 2026-03-24)
- [x] `scripts/burst-weather.ts` — concurrent burst test script (CONCURRENCY × ROUNDS, default 5×4)
- [x] **First run (2026-03-24): 5/20 confirmed (25%)** — Railway undici broken state; diagnosed and fixed
  - Root cause: Railway's native `fetch()` (undici) entered broken networking state after service restart
  - Fix 1: Service redeploy cleared undici state → signing service and Open-Meteo both recovered
  - Fix 2: Weather handler `fetch()` → `https.request()` (`httpsGetJson` helper) — immune to future undici failures
- [x] **Second run (2026-03-24): 20/20 confirmed (100%)** — all clean after redeploy
  - avg 28153ms, p95 38001ms, 6 lock retries total
  - Per-agent settling lock working correctly (retries observed in round 2)

### Failure analysis (from Railway logs — first run)
Two distinct failure modes under 5-concurrent burst, both traced to Railway undici broken state:

**1. Sign failures (10/20) — 502 `failedStage: sign`**
- Root cause: `"Signing service unreachable: "` — Railway signing microservice dropping connections.
  Empty error message = undici `TypeError` before TLS handshake.
- Payment NOT committed on these failures (safe, rollback performed). ✅ Atomic.
- Fix: service redeploy restored networking.

**2. Weather failures (5/20) — 500 `Weather data unavailable`**
- Root cause: Open-Meteo API returning `fetch failed` — same undici broken state.
- Payment WAS committed on these failures — job enqueued but client received no `jobId` receipt.
- Fix: replaced `fetch()` with `https.request()` in weather handler (`httpsGetJson` helper).
  This path is now immune to undici state rot.

**3. Algod failover triggered**
- `Primary node unreachable — failing over to https://mainnet-api.4160.nodely.dev`
- Three external services (signing service, algod, Open-Meteo) all hit issues simultaneously.
- Root cause: Railway hobby-tier resource constraints under rapid burst + undici rot.

## Sprint 5 Burst Stress Test — Re-run (Sprint 16A.2 — 2026-03-24)
- [x] `scripts/burst-stress-test.ts --x402` — 5 concurrent `/api/execute` calls
- [x] **5/5 queued, 0 rate-limited, 5/5 confirmed on-chain**
- [x] p50 enqueue 2086ms, **p95 enqueue 2346ms** (target < 5000ms ✅)
- [x] p50 confirmation 6913ms, p95 confirmation 11543ms
- [x] Ran with `weather-test-agent` rekeyed to prod signer `6RZV6XEP6...` — valid production test ✅
