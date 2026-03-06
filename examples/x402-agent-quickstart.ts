/**
 * x402 Agent Quickstart — TypeScript
 *
 * Shows the three core operations every AI agent needs:
 *   1. Register agent (once per agent lifetime)
 *   2. Submit a USDC transaction
 *   3. Confirm the on-chain result
 *
 * Usage:
 *   X402_PORTAL_SECRET=<secret> \
 *   ALGO_MNEMONIC="your 25-word mnemonic" \
 *   npx tsx examples/x402-agent-quickstart.ts
 *
 * Docs: https://ai-agentic-wallet.com/docs/api-reference.md
 */

import algosdk from "algosdk";
import { AlgoAgentClient, X402Error, type SettlementResult } from "@algo-wallet/x402-client";

// ── Config ─────────────────────────────────────────────────────

const BASE_URL      = process.env.X402_BASE_URL      ?? "https://ai-agentic-wallet.com";
const PORTAL_SECRET = process.env.X402_PORTAL_SECRET ?? "";
const AGENT_ID      = process.env.X402_AGENT_ID      ?? "my-agent-v1";
const MNEMONIC      = process.env.ALGO_MNEMONIC      ?? "";

if (!PORTAL_SECRET) throw new Error("X402_PORTAL_SECRET is required");
if (!MNEMONIC)      throw new Error("ALGO_MNEMONIC is required");

const account = algosdk.mnemonicToSecretKey(MNEMONIC);

// ── Shared auth header ─────────────────────────────────────────

const portalHeaders = {
  "Content-Type":  "application/json",
  "Authorization": `Bearer ${PORTAL_SECRET}`,
};

// ── SDK client (handles x402 handshake + payment proof) ────────

const client = new AlgoAgentClient({
  baseUrl:    BASE_URL,
  privateKey: account.sk,
});

// ══════════════════════════════════════════════════════════════
// 1. REGISTER AGENT
// ══════════════════════════════════════════════════════════════
//
// Creates an Algorand wallet for this agent, opts it into USDC,
// and rekeys it to the Rocca signing infrastructure — all in one
// atomic group. Call once. Returns 409 if already registered.

interface RegisterResponse {
  status:             "registered";
  agentId:            string;
  address:            string;
  cohort:             string;
  authAddr:           string;
  registrationTxnId: string;
  explorerUrl:        string;
}

async function registerAgent(): Promise<RegisterResponse> {
  const res = await fetch(`${BASE_URL}/api/agents/register`, {
    method:  "POST",
    headers: portalHeaders,
    body:    JSON.stringify({ agentId: AGENT_ID, platform: "typescript-sdk" }),
  });

  if (res.status === 409) {
    // Already registered — not an error
    console.log(`[register] Agent "${AGENT_ID}" already registered.`);
    return getAgentStatus() as Promise<RegisterResponse>;
  }

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Registration failed ${res.status}: ${err.error}`);
  }

  return res.json();
}

// ══════════════════════════════════════════════════════════════
// 2. SUBMIT USDC TRANSACTION
// ══════════════════════════════════════════════════════════════
//
// Two-step: the SDK handles the x402 handshake on /api/agent-action,
// then we forward the sealed sandbox to /api/execute with portal auth.
//
// Returns the settlement result, or a velocity block (402 body) if the
// agent's rolling spend window is at capacity.

interface VelocityBlock {
  error:             "VELOCITY_APPROVAL_REQUIRED";
  tenMinTotal:       string;
  dayTotal:          string;
  threshold10m:      string;
  threshold24h:      string;
  proposedMicroUsdc: string;
}

type SubmitResult = SettlementResult | VelocityBlock;

async function submitTransaction(params: {
  senderAddress:        string;
  amountMicroUsdc:      number;
  destinationChain:     "ethereum" | "solana" | "base" | "algorand";
  destinationRecipient: string;
}): Promise<SubmitResult> {
  console.log(`[submit] Building atomic group via x402 handshake...`);

  // Step 1: /api/agent-action — SDK absorbs the 402 bounce automatically
  const sandboxResponse = await client.requestSandboxExport({
    senderAddress:        params.senderAddress,
    amount:               params.amountMicroUsdc,
    destinationChain:     params.destinationChain,
    destinationRecipient: params.destinationRecipient,
  });

  console.log(`[submit] Sandbox sealed: ${sandboxResponse.export.sandboxId}`);
  console.log(`[submit] Forwarding to /api/execute...`);

  // Step 2: /api/execute — requires portal auth header
  const execRes = await fetch(`${BASE_URL}/api/execute`, {
    method:  "POST",
    headers: portalHeaders,
    body:    JSON.stringify({
      sandboxExport: sandboxResponse.export,
      agentId:       AGENT_ID,
    }),
  });

  // Velocity ceiling exceeded — agent must wait or request approval token
  if (execRes.status === 402) {
    return execRes.json() as Promise<VelocityBlock>;
  }

  // Rate limited — check Retry-After header
  if (execRes.status === 429 || execRes.status === 503) {
    const retryAfter = execRes.headers.get("Retry-After") ?? "60";
    const body       = await execRes.json();
    throw new Error(
      `[${body.error}] Retry after ${retryAfter}s.` +
      (body.error === "SIGNER_CIRCUIT_OPEN" ? " Signing service temporarily degraded." : ""),
    );
  }

  if (!execRes.ok) {
    const body = await execRes.json();
    throw new Error(`Execute failed ${execRes.status}: ${body.error ?? body.failedStage}`);
  }

  return execRes.json() as Promise<SettlementResult>;
}

// ══════════════════════════════════════════════════════════════
// 3. CHECK AGENT STATUS
// ══════════════════════════════════════════════════════════════

interface AgentStatus {
  agentId:           string;
  address:           string;
  status:            "registered" | "active" | "suspended" | "orphaned";
  cohort:            string;
  authAddr:          string;
  custody:           string;
  custodyVersion:    number;
  createdAt:         string;
  registrationTxnId: string;
}

async function getAgentStatus(): Promise<AgentStatus> {
  const res = await fetch(
    `${BASE_URL}/api/agents/${encodeURIComponent(AGENT_ID)}`,
    { headers: portalHeaders },
  );

  if (res.status === 404) throw new Error(`Agent not found: ${AGENT_ID}`);
  if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

  return res.json();
}

// ══════════════════════════════════════════════════════════════
// MAIN — end-to-end demo
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // 1. Register (idempotent)
  console.log("\n── 1. REGISTER AGENT ────────────────────────────────");
  const reg = await registerAgent();
  console.log(`   agentId: ${reg.agentId}`);
  console.log(`   address: ${reg.address}`);

  // 2. Check status before submitting
  console.log("\n── 2. CHECK STATUS ──────────────────────────────────");
  const status = await getAgentStatus();
  console.log(`   status:  ${status.status}`);
  console.log(`   cohort:  ${status.cohort}`);

  if (status.status === "suspended" || status.status === "orphaned") {
    throw new Error(`Agent is ${status.status} and cannot sign transactions.`);
  }

  // Fund reminder (off-chain — send USDC to status.address)
  console.log(`\n   ⚡ Fund "${status.address}" with USDC on Algorand mainnet`);
  console.log(`      before submitting transactions.\n`);

  // 3. Submit USDC transaction
  console.log("── 3. SUBMIT TRANSACTION ────────────────────────────");
  const AMOUNT_USDC = 1.0;

  let result: SubmitResult;
  try {
    result = await submitTransaction({
      senderAddress:        status.address,
      amountMicroUsdc:      Math.round(AMOUNT_USDC * 1_000_000),
      destinationChain:     "ethereum",
      destinationRecipient: "0xYourEthereumAddress",
    });
  } catch (err) {
    if (err instanceof X402Error) {
      console.error(`   x402 protocol error: ${err.message}`);
    } else {
      console.error(`   Error: ${(err as Error).message}`);
    }
    return;
  }

  // 4. Confirm on-chain result
  console.log("\n── 4. RESULT ────────────────────────────────────────");

  if ("error" in result && result.error === "VELOCITY_APPROVAL_REQUIRED") {
    const spent10m = Number(result.tenMinTotal)  / 1e6;
    const spent24h = Number(result.dayTotal)     / 1e6;
    const cap10m   = Number(result.threshold10m) / 1e6;
    const cap24h   = Number(result.threshold24h) / 1e6;

    console.log(`   STATUS: VELOCITY BLOCK`);
    console.log(`   10-min window: $${spent10m.toFixed(2)} / $${cap10m.toFixed(2)} USDC`);
    console.log(`   24-hour window: $${spent24h.toFixed(2)} / $${cap24h.toFixed(2)} USDC`);
    console.log(`   Action: wait for window to roll, or request an approval token.`);
    return;
  }

  const settlement = result as SettlementResult;
  if (settlement.success) {
    console.log(`   STATUS: CONFIRMED`);
    console.log(`   txnId:  ${settlement.settlement.txnId}`);
    console.log(`   round:  ${settlement.settlement.confirmedRound}`);
    console.log(`   at:     ${settlement.settlement.settledAt}`);
    console.log(`   https://allo.info/tx/${settlement.settlement.txnId}`);
  }
}

main().catch(console.error);
