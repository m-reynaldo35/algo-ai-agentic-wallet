/**
 * register-agent — Generate a fresh agent keypair and register it
 *
 * Generates a new Algorand keypair, then registers the agent via the
 * production API (opt-in to USDC + rekey to Rocca signer).
 *
 * Usage:
 *   npx tsx scripts/register-agent.ts --agent-id my-agent-001
 *   npx tsx scripts/register-agent.ts --agent-id my-agent-001 --api-url http://localhost:4020
 *
 * The script prints the mnemonic and address once — save them immediately.
 * Fund the address with ≥ 0.5 ALGO and sufficient USDC before calling the API.
 *
 * Required env:
 *   PORTAL_API_SECRET  — Portal API key for /api/agents/register-existing
 *
 * Optional env:
 *   API_URL            — defaults to https://api.ai-agentic-wallet.com
 */

import algosdk from "algosdk";
import "dotenv/config";

// ── Args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const agentIdIdx = args.indexOf("--agent-id");
const apiUrlIdx  = args.indexOf("--api-url");

const AGENT_ID   = agentIdIdx  !== -1 ? args[agentIdIdx + 1]  : undefined;
const API_URL    = (apiUrlIdx  !== -1 ? args[apiUrlIdx + 1]   : process.env.API_URL ?? "https://api.ai-agentic-wallet.com").replace(/\/+$/, "");
const PORTAL_SECRET = process.env.PORTAL_API_SECRET;

if (!AGENT_ID) {
  console.error("[FATAL] --agent-id is required. Example: --agent-id my-agent-001");
  process.exit(1);
}
if (!PORTAL_SECRET) {
  console.error("[FATAL] PORTAL_API_SECRET is required in .env");
  process.exit(1);
}

// ── Generate keypair ───────────────────────────────────────────────

const account  = algosdk.generateAccount();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
const address  = account.addr.toString();

console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  register-agent — New Keypair Generated                          ║
╠══════════════════════════════════════════════════════════════════╣
║  Agent ID : ${AGENT_ID.padEnd(50)}║
║  Address  : ${address.slice(0, 12)}...${address.slice(-6)}                           ║
╚══════════════════════════════════════════════════════════════════╝

  Mnemonic (save this now — shown once only):
  ${mnemonic}

  Full address:
  ${address}
`);

// ── Manual funding instructions ────────────────────────────────────

console.log(`Next steps:
  1. Send ≥ 0.5 ALGO to ${address}
     (covers MBR + USDC opt-in + rekey fees)

  2. Send USDC to ${address}
     (mainnet ASA 31566704 — amount depends on your intended usage)

  3. Once funded, run:

     ALGO_MNEMONIC="${mnemonic.split(" ").slice(0, 3).join(" ")} ..." \\
     AGENT_ID="${AGENT_ID}" \\
     npx tsx scripts/register-agent.ts --agent-id ${AGENT_ID} --register

  Or register manually via the API:

     curl -X POST ${API_URL}/api/agents/register-existing \\
       -H "Authorization: Bearer $PORTAL_API_SECRET" \\
       -H "Content-Type: application/json" \\
       -d '{"agentId":"${AGENT_ID}","mnemonic":"<25 words>"}'
`);

// ── Optional: register immediately if --register flag and ALGO_MNEMONIC match ──

if (args.includes("--register")) {
  const mnemonicEnv = process.env.ALGO_MNEMONIC;
  if (!mnemonicEnv) {
    console.error("[FATAL] --register requires ALGO_MNEMONIC set to the agent mnemonic");
    process.exit(1);
  }

  console.log(`[register-agent] Registering ${AGENT_ID} via ${API_URL}...`);

  const res = await fetch(`${API_URL}/api/agents/register-existing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${PORTAL_SECRET}`,
    },
    body: JSON.stringify({ agentId: AGENT_ID, mnemonic: mnemonicEnv }),
  });

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    console.error(`[register-agent] Registration failed (${res.status}):`, body);
    process.exit(1);
  }

  console.log(`[register-agent] ✓ Registered`);
  console.log(`  authAddr : ${body.authAddr ?? "(see response)"}`);
  console.log(`  rekeyTxid: ${body.txid ?? body.rekeyTxid ?? "(see response)"}`);
  console.log();
  console.log(`Add to .env:`);
  console.log(`  AGENT_ID=${AGENT_ID}`);
  console.log(`  ALGO_MNEMONIC=${mnemonicEnv}`);
}
