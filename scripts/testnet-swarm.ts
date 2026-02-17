import "dotenv/config";
import algosdk from "algosdk";

/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  TESTNET AGGREGATOR SWARM — Replay Attack Firewall Verification    │
 * │                                                                     │
 * │  Simulates a third-party AI aggregator bot slamming the x402       │
 * │  endpoint with multiple back-to-back cross-chain trade requests.   │
 * │                                                                     │
 * │  Includes a deliberate Replay Attack test: captures a valid        │
 * │  X-PAYMENT header and re-sends it to prove the firewall blocks     │
 * │  the duplicate request with HTTP 401.                               │
 * │                                                                     │
 * │  Run: npx tsx scripts/testnet-swarm.ts                              │
 * │  Env: API_URL (default: http://localhost:4020)                      │
 * └─────────────────────────────────────────────────────────────────────┘
 */

// ── Config ──────────────────────────────────────────────────────
const API_URL = process.env.API_URL || "http://localhost:4020";
const SWARM_SIZE = 5; // Number of legitimate sequential trades
const DEST_CHAINS = ["ethereum", "solana", "base", "arbitrum", "optimism"];

// ── Helpers ─────────────────────────────────────────────────────

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`  ${ts}  [${tag}] ${msg}`);
}

function separator(label: string) {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ${label}`);
  console.log(`${"═".repeat(64)}\n`);
}

function assert(condition: boolean, msg: string): asserts condition {
  if (!condition) {
    console.error(`\n  ✗ ASSERTION FAILED: ${msg}\n`);
    process.exit(1);
  }
}

/**
 * Build a valid X-PAYMENT header with fresh timestamp and unique nonce.
 */
function buildPaymentProof(
  agentAccount: algosdk.Account,
): { header: string; nonce: string; timestamp: number } {
  const agentAddr = agentAccount.addr.toString();

  const mockParams: algosdk.SuggestedParams = {
    flatFee: true,
    fee: BigInt(1000),
    minFee: BigInt(1000),
    firstValid: BigInt(1000),
    lastValid: BigInt(2000),
    genesisID: "testnet-v1.0",
    genesisHash: new Uint8Array(32),
  };

  const txn0 = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: agentAddr,
    receiver: agentAddr,
    amount: BigInt(0),
    suggestedParams: mockParams,
  });
  const txn1 = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: agentAddr,
    receiver: agentAddr,
    amount: BigInt(0),
    suggestedParams: mockParams,
  });

  const txns = [txn0, txn1];
  algosdk.assignGroupID(txns);

  const groupId = Buffer.from(txns[0].group!).toString("base64");
  const signedTxns = txns.map((t) => t.signTxn(agentAccount.sk));
  const groupIdBytes = Buffer.from(groupId, "base64");
  const signature = algosdk.signBytes(groupIdBytes, agentAccount.sk);

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = `swarm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const proof = {
    groupId,
    transactions: signedTxns.map((s) => Buffer.from(s).toString("base64")),
    senderAddr: agentAddr,
    signature: Buffer.from(signature).toString("base64"),
    timestamp,
    nonce,
  };

  const header = Buffer.from(JSON.stringify(proof)).toString("base64");
  return { header, nonce, timestamp };
}

// ── Swarm Simulation ────────────────────────────────────────────

async function runSwarm() {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  TESTNET AGGREGATOR SWARM`);
  console.log(`  Target: ${API_URL}`);
  console.log(`  Swarm size: ${SWARM_SIZE} legitimate trades`);
  console.log(`  + 1 deliberate replay attack`);
  console.log(`${"═".repeat(64)}`);

  // ── Pre-flight: Health check ─────────────────────────────────
  separator("PRE-FLIGHT: Health Check");

  const healthRes = await fetch(`${API_URL}/health`);
  const healthBody = await healthRes.json() as Record<string, string>;
  assert(healthRes.status === 200, "Server is down");
  log("SWARM", `Server alive: ${healthBody.protocol} on ${healthBody.network}`);

  // ── Generate aggregator bot identity ─────────────────────────
  const botAccount = algosdk.generateAccount();
  const botAddr = botAccount.addr.toString();
  log("SWARM", `Aggregator bot wallet: ${botAddr.slice(0, 12)}...${botAddr.slice(-6)}`);

  // ── Phase 1: Legitimate Trade Swarm ──────────────────────────
  separator("PHASE 1: Legitimate Trade Swarm");
  log("SWARM", `Firing ${SWARM_SIZE} sequential trades with unique nonces...\n`);

  let capturedHeader: string | null = null;
  let capturedNonce: string | null = null;
  let successCount = 0;
  let expectedFailCount = 0;

  for (let i = 0; i < SWARM_SIZE; i++) {
    const destChain = DEST_CHAINS[i % DEST_CHAINS.length];
    const { header, nonce } = buildPaymentProof(botAccount);

    // Capture the first successful header for the replay attack test
    if (i === 0) {
      capturedHeader = header;
      capturedNonce = nonce;
    }

    log(`BOT[${i}]`, `Trade #${i + 1}: algorand -> ${destChain} | nonce: ${nonce.slice(0, 20)}...`);

    const res = await fetch(`${API_URL}/api/agent-action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": header,
        "X-SLIPPAGE-BIPS": "50",
      },
      body: JSON.stringify({
        senderAddress: botAddr,
        destinationChain: destChain,
      }),
    });

    if (res.status === 200) {
      const body = await res.json() as Record<string, any>;
      log(`BOT[${i}]`, `HTTP 200 — SandboxExport received (txns: ${body.export?.atomicGroup?.txnCount})`);
      successCount++;
    } else if (res.status === 500) {
      // Expected if treasury address is placeholder
      const body = await res.json() as Record<string, string>;
      if (body.detail?.includes("address seems to be malformed")) {
        log(`BOT[${i}]`, `HTTP 500 — Treasury placeholder (expected in dev). Proof was ACCEPTED.`);
        expectedFailCount++;
      } else {
        log(`BOT[${i}]`, `HTTP ${res.status} — ${body.error}: ${body.detail}`);
      }
    } else if (res.status === 401) {
      const body = await res.json() as Record<string, string>;
      log(`BOT[${i}]`, `HTTP 401 — REJECTED: ${body.detail}`);
      assert(false, `Legitimate trade #${i + 1} was rejected as replay!`);
    } else {
      const body = await res.json() as Record<string, string>;
      log(`BOT[${i}]`, `HTTP ${res.status} — ${JSON.stringify(body)}`);
    }
  }

  const passedFirewall = successCount + expectedFailCount;
  log("SWARM", `\n  Swarm complete: ${passedFirewall}/${SWARM_SIZE} trades passed the firewall`);
  assert(passedFirewall === SWARM_SIZE, `Expected all ${SWARM_SIZE} legitimate trades to pass`);

  // ── Phase 2: The Malicious Actor — Replay Attack ─────────────
  separator("PHASE 2: Replay Attack (The Malicious Actor)");

  assert(capturedHeader !== null, "No header was captured for replay test");
  log("ATTACKER", `Intercepted a valid X-PAYMENT header from Trade #1`);
  log("ATTACKER", `Captured nonce: ${capturedNonce!.slice(0, 20)}...`);
  log("ATTACKER", `Attempting to replay the captured signature...\n`);

  const replayRes = await fetch(`${API_URL}/api/agent-action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": capturedHeader!,
      "X-SLIPPAGE-BIPS": "50",
    },
    body: JSON.stringify({
      senderAddress: botAddr,
      destinationChain: "ethereum",
    }),
  });

  const replayBody = await replayRes.json() as Record<string, string>;

  log("ATTACKER", `HTTP ${replayRes.status} — ${JSON.stringify(replayBody)}`);

  assert(
    replayRes.status === 401,
    `Expected HTTP 401 for replay attack, got ${replayRes.status}`,
  );
  assert(
    replayBody.error?.includes("Replay Detected"),
    `Expected "Replay Detected" error, got: ${replayBody.error}`,
  );

  log("FIREWALL", `BLOCKED: ${replayBody.error}`);
  log("FIREWALL", `Detail:  ${replayBody.detail}`);

  // ── Phase 3: Stale Timestamp Attack ──────────────────────────
  separator("PHASE 3: Stale Timestamp Attack");

  log("ATTACKER", "Constructing a proof with a 90-second-old timestamp...\n");

  // Build a fresh proof but backdate the timestamp beyond the 60s bound
  const staleProofData = JSON.parse(
    Buffer.from(buildPaymentProof(botAccount).header, "base64").toString("utf-8"),
  );
  staleProofData.timestamp = Math.floor(Date.now() / 1000) - 90; // 90 seconds ago
  staleProofData.nonce = `stale-attack-${Date.now()}`; // Fresh nonce to isolate the test

  const staleHeader = Buffer.from(JSON.stringify(staleProofData)).toString("base64");

  const staleRes = await fetch(`${API_URL}/api/agent-action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": staleHeader,
      "X-SLIPPAGE-BIPS": "50",
    },
    body: JSON.stringify({
      senderAddress: botAddr,
      destinationChain: "solana",
    }),
  });

  const staleBody = await staleRes.json() as Record<string, string>;

  log("ATTACKER", `HTTP ${staleRes.status} — ${JSON.stringify(staleBody)}`);

  assert(
    staleRes.status === 401,
    `Expected HTTP 401 for stale timestamp attack, got ${staleRes.status}`,
  );

  log("FIREWALL", `BLOCKED: ${staleBody.error}`);
  log("FIREWALL", `Detail:  ${staleBody.detail}`);

  // ── Results ──────────────────────────────────────────────────
  separator("SWARM RESULTS");

  console.log("  Legitimate Trades:");
  console.log(`    [PASS] ${passedFirewall}/${SWARM_SIZE} trades passed the firewall with unique nonces`);
  console.log("");
  console.log("  Attack Vectors:");
  console.log("    [PASS] Replay Attack    — HTTP 401 (duplicate nonce blocked)");
  console.log("    [PASS] Stale Timestamp  — HTTP 401 (90s > 60s time bound)");
  console.log("");
  console.log("  Firewall Status: OPERATIONAL");
  console.log("  Replay Prevention: VERIFIED");
  console.log(`  Nonce enforcement: ΔT ≤ 60s strict, single-use nonces\n`);
}

// ── Run ─────────────────────────────────────────────────────────
runSwarm().catch((err) => {
  console.error(`\n  FATAL: ${err.message}\n`);
  if (err.cause?.code === "ECONNREFUSED") {
    console.error("  Is the server running? Start it with: npm run dev\n");
  }
  process.exit(1);
});
