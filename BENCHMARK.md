# A2A Payment Rail — Benchmark Results

Live results always available at: `GET https://api.ai-agentic-wallet.com/api/benchmark`

---

## Latest Run — 2026-03-22

```
╔══════════════════════════════════════════════════════════════════════╗
║  A2A BENCHMARK RESULTS                                               ║
╠══════════════════════════════════════════════════════════════════════╣
║  Duration    : 47.40s      Payments fired : 100                      ║
║  Confirmed   : 100         Failed         : 0                        ║
║  Throughput  : 126.6 tx/min  USDC spent   : $1.00                    ║
╠══════════════════════════════════════════════════════════════════════╣
║  Latency                  p50           p95           p99            ║
╠══════════════════════════════════════════════════════════════════════╣
║  x402 handshake         549ms        1273ms        1693ms            ║
║  Settlement            9712ms       14193ms       15694ms            ║
║  End-to-end           10737ms       15359ms       16899ms            ║
╚══════════════════════════════════════════════════════════════════════╝
```

**100/100 payments confirmed. Zero failures. $1.00 USDC settled on Algorand mainnet.**

### On-chain receipts (sample)

| # | Transaction ID | Explorer |
|---|---|---|
| 1 | `S7QJRCIS7PXUXWHIQPU2IL7MYW2BUEC753TTAZYKITKI2QJXYWRQ` | [View](https://explorer.perawallet.app/tx/S7QJRCIS7PXUXWHIQPU2IL7MYW2BUEC753TTAZYKITKI2QJXYWRQ) |
| 2 | `DOBY7VLEVQWVMOFU6PNC7A53BZZGXEYBK3O54JQYHOS3VY4D4KZA` | [View](https://explorer.perawallet.app/tx/DOBY7VLEVQWVMOFU6PNC7A53BZZGXEYBK3O54JQYHOS3VY4D4KZA) |
| 3 | `VMKZHNKRE7MKPUHO5MFE5FVS4AMFQQOHWYYAPWAY2RBLMLSL7WEA` | [View](https://explorer.perawallet.app/tx/VMKZHNKRE7MKPUHO5MFE5FVS4AMFQQOHWYYAPWAY2RBLMLSL7WEA) |

---

## Methodology

### What was tested

A real AI agent paid $0.01 USDC per request, 100 times, against the production API on Algorand mainnet. No mocks. No testnet. Every confirmation is an irreversible on-chain transaction.

### Traffic pattern

- **Arrival process**: Poisson (λ=1.5 payments/s — avg 667ms between firings)
- **Burst clusters**: 25% probability of firing 3–6 concurrent payments at 80ms gaps
- **Peak concurrency**: 46 in-flight settlements simultaneously
- **Total duration**: 47.40 seconds

This models realistic AI agent behaviour: steady background requests with occasional bursts when an agent completes a batch task.

### What "confirmed" means

A payment is only counted as confirmed when:
1. The x402 handshake completes (402 → proof → data)
2. The settlement transaction is signed by Rocca (FIDO2 hardware-backed key)
3. The Algorand node broadcasts the atomic group
4. `waitForConfirmation` returns a block round — the transaction is irreversibly on-chain

SSE (Server-Sent Events) streams the confirmation back to the client in real-time. No polling.

### What "settlement latency" means

Time from job enqueue (server receives execute request) to on-chain confirmation. Includes:
- Algorand atomic group construction
- Rocca signing via FIDO2
- Algod broadcast
- Block confirmation (~3.9s average block time on mainnet)

### What "e2e latency" means

Full wall-clock time from payment initiation to on-chain confirmation, including the x402 handshake round-trip.

---

## Infrastructure

| Component | Value |
|---|---|
| Network | Algorand Mainnet |
| RPC | Nodely (primary) + Algonode (fallback) |
| Signing | Rocca FIDO2 hardware-backed key |
| Queue | Redis (Upstash) |
| Settlement workers | 15 parallel |
| Rate limiting | Upstash sliding window |
| Circuit breaker | 30 failure threshold / 60s window |

---

## How to reproduce

```bash
git clone https://github.com/m-reynaldo35/algo-ai-agentic-wallet
cd algo-ai-agentic-wallet
npm install

# Fund a USDC-opted-in Algorand mainnet wallet with $1.00 USDC
# Register agent via POST /api/agents/register-existing

ALGO_MNEMONIC="your 25-word mnemonic" \
PORTAL_API_SECRET="your portal key" \
AGENT_ID="your-agent-id" \
API_URL="https://api.ai-agentic-wallet.com" \
npx tsx scripts/a2a-benchmark.ts
```

Results are posted to `GET /api/benchmark` automatically after each run.
