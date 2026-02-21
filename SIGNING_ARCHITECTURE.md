# Algorand Agent Signing Architecture
## x402 / Rocca / Liquid Auth — Production Design

---

## Service Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  PUBLIC TIER                                                        │
│                                                                     │
│  AI Agents ──► x402 API (Railway)                                   │
│                  │  X-PAYMENT proof (identity claim)                │
│                  │  Liquid Auth FIDO2 (who is asking?)              │
└──────────────────┼──────────────────────────────────────────────────┘
                   │  validated request + agentId
┌──────────────────▼──────────────────────────────────────────────────┐
│  SIGNING TIER  (internal, no public ingress)                        │
│                                                                     │
│  Signing Service                                                    │
│    ├── Agent Registry  (agentId → agent address → cohort)           │
│    ├── Cohort Router   (routes to correct signer key)               │
│    └── Signer Pool                                                  │
│          ├── Cohort A signer  (agents 0–9,999)                      │
│          ├── Cohort B signer  (agents 10k–19,999)                   │
│          └── Cohort N signer  ...                                   │
└──────────────────┬──────────────────────────────────────────────────┘
                   │  signed txn bytes
┌──────────────────▼──────────────────────────────────────────────────┐
│  KEY VAULT (HSM / Vault / KMS)                                      │
│                                                                     │
│  Private key material never leaves this boundary.                   │
│  Signing service sends raw bytes IN, receives signature OUT.        │
└──────────────────┬──────────────────────────────────────────────────┘
                   │  signed transactions
┌──────────────────▼──────────────────────────────────────────────────┐
│  ALGORAND MAINNET                                                   │
│                                                                     │
│  Agent address (sender)  ←── auth-addr = Cohort signer             │
│  Treasury address        ←── receives USDC tolls                    │
│  Cold wallet             ←── treasury sweeps (guardian cron)        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Hierarchy

```
ROOT (air-gapped, never online)
  └── Master Rotation Key
        Used only to rekey cohort signers during rotation.
        Stored: HSM or hardware wallet in physical vault.

COHORT SIGNERS (hot, HSM-protected)
  ├── Cohort-A Key  →  auth-addr for agents 0–9,999
  ├── Cohort-B Key  →  auth-addr for agents 10k–19,999
  └── Cohort-N Key  ...

TREASURY (warm)
  └── Treasury Address  →  receives x402 USDC tolls
        Separate from all signer keys.
        Swept to cold wallet by wallet-guardian.

AGENT ADDRESSES (public only, no private key needed)
  └── Each agent has an Algorand address rekeyed to their cohort signer.
        Agent's private key is discarded after rekey — only Rocca signs.
```

---

## Cohort Strategy

```
Cohort size:  10,000 agents per signer key

At 100k agents:  10 cohort keys
At 1M agents:   100 cohort keys

Assignment:  deterministic by agentId hash
  cohortIndex = sha256(agentId) % totalCohorts

Why 10k per cohort:
  - Blast radius of one compromised key = 10k agents max
  - Rotation txn volume is manageable (10k rekey txns ≈ ~$10 ALGO fees)
  - Parallelise rotation across cohorts independently
  - Easy to add new cohorts without touching existing ones
```

---

## Trust Boundaries

```
BOUNDARY 1: Public → API
  Enforced by:  X-PAYMENT proof (cryptographic), Liquid Auth (FIDO2)
  Threat:       Spoofed agent identity, replay attacks
  Mitigation:   Nonce + timestamp in X-PAYMENT, Redis replay guard

BOUNDARY 2: API → Signing Service
  Enforced by:  mTLS or internal VPC-only network, signed JWT
  Threat:       SSRF, rogue signing request
  Mitigation:   Allowlist of valid (agentId, address) pairs before signing

BOUNDARY 3: Signing Service → HSM
  Enforced by:  Hardware boundary — bytes in, signature out
  Threat:       Key extraction
  Mitigation:   Private key material never serialised to memory outside HSM

BOUNDARY 4: Treasury ↔ Signer keys
  Enforced by:  Completely separate addresses, no shared key material
  Threat:       Signer compromise drains treasury
  Mitigation:   Signer keys hold ALGO for fees only (guardian sweeps excess)
```

---

## Failure Modes

| Failure | Impact | Recovery |
|---|---|---|
| Cohort key compromised | Agents in that cohort cannot sign | Rotate: master key rekeys all agents in cohort to new signer |
| HSM unavailable | All signing halted | Failover HSM replica in separate region |
| Signing service down | Queue fills, agents timeout | Stateless service — restart, process queued requests |
| Agent Registry unavailable | Cannot route to correct cohort | Read replica, Redis cache of agentId→cohort mapping |
| Algorand congestion | Txns timeout | Retry with fee bump, exponential backoff |
| Treasury not swept | USDC accumulates on-chain (low risk) | Guardian cron alert fires, manual sweep |
| Rotation mid-flight | Some agents on old key, some on new | Dual-key window: old signer stays live until all rekeys confirmed |

---

## MPC Migration Path

```
Phase 1 (now):    Single HSM key per cohort
                  → Simple, auditable, implementable today

Phase 2:          Threshold signatures (2-of-3 key shards)
                  → Same auth-addr on-chain, no rekey needed
                  → Signing service calls MPC coordinator
                  → No agent-visible change

Phase 3:          Full MPC with distributed key generation
                  → Shard holders: Rocca + operator + agent (optional)
                  → Rekey to MPC-derived address if key changes
```

---

## What Changes in the Codebase

```
NEW:  POST /api/agents/register
        → generate agent address
        → submit rekey txn (agent addr → cohort signer as auth-addr)
        → store agentId → address → cohort in Redis

CHANGE: RoccaWallet.signAtomicGroup
        → accept agentId
        → look up agent address + cohort signer
        → sign with cohort key, sender = agent address

CHANGE: transaction.ts constructAtomicGroup
        → sender = agent's rekeyed address (not server signer)

CHANGE: validation.ts
        → verify auth-addr of sender === cohort signer (not sender === signer)

KEEP:   Liquid Auth — still identifies which agent is requesting
KEEP:   X-PAYMENT proof — still proves agent authorised the action
KEEP:   Treasury address — completely unchanged
KEEP:   wallet-guardian — watches cohort signer ALGO balances for fees
```

---

## Implementation Phases

### Phase 1 — Single Cohort (now)
- One Rocca signer key (current `ALGO_SIGNER_MNEMONIC`)
- All agents rekeyed to this single key
- Agent Registry in Redis: `agentId → { address, cohort: "A" }`
- Implement `/api/agents/register` endpoint

### Phase 2 — Multi-Cohort (at ~5k agents)
- Add cohort keys to Key Vault
- Cohort Router assigns new agents by hash
- Existing agents stay on Cohort A until next rotation window

### Phase 3 — HSM (at production scale)
- Replace env-var mnemonic with HSM-backed signing
- AWS CloudHSM / Azure Dedicated HSM / HashiCorp Vault Transit
- Signing service becomes a sidecar — same API, different backend

### Phase 4 — MPC (future)
- Threshold signing replaces single HSM key per cohort
- No on-chain changes required if auth-addr is preserved
- Rocca handles MPC coordination

---

## Current Signer Address
- Address: `2FBKPEIDUQXMPYANXTSUHOGRXVPSYCW2XUBCKRNOI5POJZOFCSNN4JRBDA`
- Role: Cohort A signer (Phase 1)
- USDC opted in: yes
- ALGO balance: 10 ALGO (for fees)
