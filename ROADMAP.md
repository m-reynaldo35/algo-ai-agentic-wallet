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

## Current State (after Sprint 13 + CLI)

- Railway backend live: `https://api.ai-agentic-wallet.com`
- Vercel frontend live: `https://ai-agentic-wallet.com`
- Redis internal TCP active — avg enqueue ~1,250ms
- Auth-addr cache (5-min TTL) eliminates algod round-trips
- Nodely failover active (primary → fallback + recovery probe)
- SDK `@algo-wallet/x402-client@0.2.0` — built, not yet published to npm
- MCP server `@algo-wallet/x402-mcp@0.1.0` — built, not yet published
- Python SDK `algo-x402@0.1.0` — built, not yet published
- CLI `@algo-wallet/x402-cli@0.1.0` — built, not yet published
- Gas station code complete — **awaiting treasury wallet + env var to activate**
- Customer dashboard: mandates inline, revoked counts, wallet QR sidebar, agent status card
- Admin portal: all pages built (dashboard, treasury, agents, security, logs, settings)
- Treasury page: live ALGO/USDC balances + gas station status via `/api/portal/treasury-status`
- `tsc --noEmit` passes clean on backend + portal

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

### 1.2 Admin Wallet Whitelist

- [x] Set `ADMIN_WALLET_ADDRESSES=<your-algo-address>` on Vercel developer portal env vars
- [ ] Verify: scan QR at `/login` with your wallet → redirects to `/dashboard`
- [ ] Verify: a different wallet gets 403 "not on the admin whitelist"

### 1.3 Wallet Guardian Audit

- [x] Guardian monitors `ALGO_SIGNER_ADDRESS` balance on every cycle
- [x] Low-balance alert fires when balance < `SIGNER_LOW_ALERT_ALGO`
- [x] Auth-addr rekey detection fires CRITICAL alert + halt
- [x] Deploy guardian to Railway as a separate worker service
- [x] Set `CHECK_INTERVAL_S=10`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` in Railway guardian vars
- [x] Verify Telegram alerts fire end-to-end: `npm run guardian:test`
- [ ] Verify treasury USDC sweep fires correctly

---

## Sprint 6 — System Audit *(ops tasks remain)*

### 6.1 Security Audit
- [ ] All secrets rotated (Sprint 1.1)
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
- [ ] Check Railway memory/CPU metrics — no leak after sustained load
- [ ] Nodely free tier latency acceptable — upgrade to paid if p95 > 200ms

### 6.3 Operational Readiness
- [x] `/health` returns full subsystem status
- [x] Guardian `railway.guardian.json` fixed — restart policy `ALWAYS`
- [x] Runbook written — `docs/runbook.md`
- [x] Railway service restart policy set to `always` on main API
- [ ] Railway deploy notifications wired (Slack or email on fail)
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

## Sprint L — Liquid Auth Native Integration *(current)*

**Goal:** Replace the custom `algorand-liquid-auth` JSON QR protocol (which Pera does not
understand) with the official AVM Labs Liquid Auth open-source stack. Pera wallet has
native support for this protocol — no WalletConnect dependency required.

**References:**
- Signal server: https://github.com/algorandfoundation/liquid-auth (NestJS)
- JS client SDK: https://github.com/algorandfoundation/liquid-auth-js
- UI helpers: https://github.com/algorandfoundation/liquid-auth-use-wallet-client
- Docs: https://docs.liquidauth.com/architecture/

### True Architecture (WebRTC + FIDO2 + WebSocket)

This is NOT a simple QR → HTTP callback flow. The official protocol uses WebRTC for
peer-to-peer communication, with the signal server brokering the WebRTC handshake.
FIDO2 credentials (derived from the Algorand private key in Pera) replace our current
`algosdk.signBytes` approach.

```
Browser (portal)         Signal Server            Pera Wallet (mobile)
      │                       │                          │
      ├─ POST /auth/start ───►│                          │
      │◄─ sessionId + QR ─────┤                          │
      │                       │                          │
      │  [open WebSocket]      │◄─ scan QR, connect ─────┤
      │◄─ link:status ─────────┤                          │
      │                       │                          │
      │  [WebRTC offer] ──────►│──────────────────────────►│
      │◄─ [WebRTC answer] ─────┤◄─────────────────────────┤
      │  [ICE candidates exchange via signal server]       │
      │                        │                          │
      │◄══ WebRTC Data Channel established ══════════════►│
      │                                                   │
      │◄══ FIDO2 PublicKeyCredential (signed by Pera) ════┤
      │                                                   │
      ├─ POST /auth/verify (signal server validates FIDO2)─►│
      │◄─ verified + Algorand address ────────────────────┤
      │                                                   │
      ├─ POST /api/admin/auth/liquid-consume (our backend)
      │◄─ address + admin JWT
```

**Infrastructure required beyond current stack:**
- NestJS signal server (new Railway service)
- STUN server (public free: `stun.l.google.com:19302`)
- TURN server (needed for strict NAT — use Twilio TURN or self-host coturn)
- WebSocket support (persistent connections, no scale-to-zero)

### L.1 — Signal Server Deploy

- [ ] Study `algorandfoundation/liquid-auth` repo structure and env var requirements
- [ ] Identify all required env vars: `DATABASE_URL`, `REDIS_URL`, `CORS_ORIGIN`, `STUN_URL`, `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD`, `PORT`
- [ ] Decide on TURN provider: Twilio (free tier) or self-hosted coturn on Railway
- [ ] If Twilio: create account, get TURN credentials, add to env
- [ ] Clone/fork signal server — do NOT copy into monorepo (keep as separate Railway-linked repo or subdirectory)
- [ ] Add `railway.liquid-auth.json` (healthcheck `/health`, restart `ALWAYS`)
- [ ] Create Railway service `liquid-auth-signal`, link to signal server codebase
- [ ] Connect signal server to shared Redis plugin
- [ ] Add custom domain `liquid-auth.api.ai-agentic-wallet.com` → signal server
- [ ] Verify: `curl https://liquid-auth.api.ai-agentic-wallet.com/health` returns 200
- [ ] Add `LIQUID_AUTH_SERVER_URL=https://liquid-auth.api.ai-agentic-wallet.com` to `algo-ai-wallet` and `developer-portal` Railway vars

### L.2 — Backend: Replace Custom Auth with FIDO2 Verification

The current `algosdk.verifyBytes` signature check is replaced by FIDO2 credential
verification delegated to the signal server.

- [ ] Update `src/auth/adminAuth.ts`:
      - `issueAdminLiquidChallenge()` → POST to signal server `/auth/start`, store returned `sessionId` in Redis, return QR URL (not JSON payload)
      - `submitAdminLiquidSignature()` → DELETE (signal server handles this; wallet communicates directly)
      - `consumeAdminLiquidSession()` → POST to signal server `/auth/status/:sessionId`, verify FIDO2 response, extract Algorand address
- [ ] Update `src/auth/humanAuth.ts` (agent governance) with same pattern
- [ ] Remove `POST /api/admin/auth/liquid-sign` route (wallet no longer POSTs here)
- [ ] Remove `POST /api/agents/:agentId/auth/liquid-sign` route (same reason)
- [ ] Add signal server API client utility in `src/services/liquidAuthClient.ts`:
      - `createSession(intent, callbackUrl)` → returns `{ sessionId, qrUrl }`
      - `getSessionStatus(sessionId)` → returns `{ status, address? }`
- [ ] Update `LIQUID_AUTH_SERVER_URL` guard in `src/protection/envGuard.ts` — fatal if unset in production
- [ ] `tsc --noEmit` passes clean

### L.3 — Frontend: Admin Login (`/login`)

- [ ] Install `@algorandfoundation/liquid-auth-js` in `apps/developer-portal`
- [ ] Rewrite `LiquidAuthPanel` in `src/app/login/page.tsx`:
      - Call `/api/admin/auth/liquid-challenge` → get `{ sessionId, qrUrl }`
      - Render QR from `qrUrl` string (simpler than JSON — `qrurl` library or existing canvas)
      - Initialise `liquid-auth-js` SDK, open WebSocket to signal server
      - SDK fires callback when FIDO2 credential received and verified
      - On verified: POST `sessionId` to `/api/auth/login` → issue admin JWT → redirect
- [ ] Remove countdown timer and manual poll loop (SDK provides real-time callback)
- [ ] Test: scan QR at `ai-agentic-wallet.com/login` with Pera → WebRTC + FIDO2 → `/dashboard`
- [ ] Test: wrong wallet → 403 "not on admin whitelist"

### L.4 — Frontend: Customer Login (`/app/login`)

- [ ] Rewrite `LiquidAuthPanel` in `src/app/app/login/page.tsx` (same SDK, same pattern)
- [ ] Test: customer wallet scan → FIDO2 → `/app/dashboard`

### L.5 — Frontend: Mandate Operations

- [ ] Rewrite `LiquidAuthQRModal.tsx`:
      - Replace JSON QR canvas with URL QR
      - Replace polling interval with SDK WebSocket callback
- [ ] Test mandate create: QR scan → FIDO2 → mandate active
- [ ] Test mandate revoke: QR scan → FIDO2 → mandate revoked

### L.6 — Cleanup

- [ ] Delete `src/auth/humanAuth.ts` functions: `submitAlgorandSignature`
- [ ] Delete `src/auth/adminAuth.ts` functions: `submitAdminLiquidSignature`
- [ ] Remove `/api/*/auth/liquid-sign` Express routes from `src/index.ts`
- [ ] Remove `qrcode` npm package from `apps/developer-portal` if no longer needed
- [ ] Update `.env` and `.env.example` with new required vars (`LIQUID_AUTH_SERVER_URL`, TURN credentials)
- [ ] Update `public/skill.md` auth section
- [ ] `tsc --noEmit` clean on backend + portal

### L.7 — E2E Verification

- [ ] Admin login: 3 consecutive QR → Pera scan → FIDO2 → `/dashboard` successes
- [ ] Admin login: wrong wallet → 403 confirmed
- [ ] Customer login: 3 consecutive successes
- [ ] Mandate create: end-to-end with real Pera scan
- [ ] Mandate revoke: end-to-end with real Pera scan
- [ ] WebAuthn path still works (regression check)
- [ ] Signal server restart does not break in-flight sessions (reconnect test)
- [ ] Load test: 10 concurrent QR sessions on signal server (no dropped WebSockets)

---

## Launch Gate Checklist

All items below must be `[x]` before going live.

- [ ] Sprint 1 complete — new wallets generated, all secrets rotated, guardian deployed
- [ ] `ADMIN_WALLET_ADDRESSES` set — admin portal locked to your Algorand wallet
- [x] Sprint 2 complete — agent creation wizard live
- [x] Sprint 3 complete — landing page live
- [ ] Sprint L complete — Liquid Auth native integration (Pera QR sign-in working)
- [x] Sprint 5 complete — burst, sustained, velocity, failover, Redis failure tests pass
- [ ] Sprint 6 complete — security audit clean, Telegram alerts verified
- [x] Sprint 8 complete — USDC-native onboarding + gas station live
- [x] Sprint 9 complete — gas station security hardening
- [ ] Sprint 10 complete — DNS + TLS verified on both domains
- [x] Sprint 11 complete — docs standalone, security hardening
- [x] Sprint 12 complete — customer dashboard complete
- [x] Sprint 13 complete — admin portal operational
- [ ] Treasury and signer wallets holding correct balances on mainnet
- [x] Cold wallet opted into USDC and verified (UI3LOTUJ...)
- [ ] Telegram alerts verified working on real phone
- [ ] `api.ai-agentic-wallet.com` → Railway, `ai-agentic-wallet.com` → Vercel
- [ ] CORS locked to production domains
- [ ] mTLS active
- [ ] `/health` returns fully green across all subsystems

---

# PHASE 2 — Ecosystem (The Marketplace)

> **Why this matters:** The buyer side is built — an AI agent with a wallet, mandate-gated
> spending, and a payment rail. Phase 2 builds the seller side and the discovery layer that
> connects them. Claude and other LLMs do the matching automatically through MCP tool discovery.
> This is the AI agent economy layer that EVM x402 cannot serve due to gas economics.

---

## Sprint 16 — Gas Station Activation + End-to-End Payment Test

**Why first:** Everything in Phase 2 depends on agents being able to pay autonomously.
The gas station ensures ALGO for fees is always available. Without it, payments fail
when the agent wallet runs low on gas regardless of USDC balance.

### 16.1 Treasury Wallet Setup
- [ ] Generate a dedicated treasury wallet (separate from agent wallet `S2P45K7N...`)
- [ ] Fund treasury with ≥ 5 ALGO (covers ~7 gas top-ups at 0.70 ALGO each)
- [ ] Opt treasury into USDC (ASA 31566704) — required to receive USDC sweeps
- [ ] Set `ALGO_TREASURY_MNEMONIC` in Railway env vars → gas station activates automatically
- [ ] Verify in Railway logs: `[GasStation] Starting — interval 30s, trigger < 500000 µALGO`
- [ ] Confirm first top-up fires: agent wallet `S2P45K7N...` receives 0.70 ALGO from treasury

### 16.2 Weather Endpoint (Entry #1 in future registry)
- [ ] Add `GET /api/weather?city=Lagos` behind `x402Paywall` — proxies Open-Meteo (free, no API key)
- [ ] Price: 1000 micro-USDC ($0.001) per call
- [ ] Returns: temperature, wind speed, weather code, timestamp

### 16.3 End-to-End Payment Test Script
- [ ] Write `scripts/buy-weather.ts` using `@algo-wallet/x402-client`:
      - Points at agent wallet `S2P45K7N...`
      - Calls `POST https://api.ai-agentic-wallet.com/api/weather?city=Lagos`
      - Absorbs 402 → pays 0.001 USDC → receives weather data
      - Logs: payment txn ID, weather response, mandate usage
- [ ] Confirm mandate enforcement fires (per-tx cap respected)
- [ ] Confirm payment appears in agent transaction history on dashboard
- [ ] Confirm on-chain USDC transfer visible on Pera Explorer

**Success criteria:** Agent autonomously pays $0.001 USDC for real weather data with no human
approval of the individual transaction. Mandate set by human covers it.

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
