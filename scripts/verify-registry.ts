#!/usr/bin/env tsx
/**
 * verify-registry — Registry reconciliation and drift detection
 *
 * Walks every agent in Redis, checks on-chain state, reports anomalies.
 *
 * Checks per agent:
 *   1. On-chain auth-addr === registry authAddr         (rekey drift)
 *   2. USDC (ASA 31566704) opted in                     (missing opt-in)
 *   3. ALGO balance >= MIN_BALANCE                       (underfunded)
 *   4. Account exists on-chain                           (ghost record)
 *
 * Writes DriftRecord to Redis for each agent with anomalies.
 * Outputs a summary and per-agent report. Exits 1 if any drift found.
 *
 * Usage:
 *   npx tsx scripts/verify-registry.ts               # read-only report
 *   npx tsx scripts/verify-registry.ts --fix-redis   # update authAddr in Redis
 *                                                    # to match on-chain truth
 *
 * Required env vars:
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   ALGORAND_NODE_URL (defaults to Nodely mainnet)
 */

import "dotenv/config";
import algosdk from "algosdk";
import { getAlgodClient } from "../src/network/nodely.js";
import {
  listAgents,
  storeDrift,
  resolveDrift,
  updateAgentRecord,
  type AgentRecord,
  type DriftRecord,
} from "../src/services/agentRegistry.js";

const USDC_ASSET_ID = BigInt(process.env.X402_USDC_ASSET_ID ?? "31566704");
const MIN_ALGO_BALANCE = 200_000; // 0.2 ALGO — min balance with 1 ASA opted in

// Rate-limit: ms between Algod calls to avoid overwhelming Nodely free tier
const ALGOD_DELAY_MS = 100;

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fixRedis = process.argv.includes("--fix-redis");
  const algod    = getAlgodClient();

  console.log("\n══════════════════════════════════════════════");
  console.log("  Registry Verification & Drift Detection");
  if (fixRedis) console.log("  Mode: FIX REDIS (updating stale authAddr)");
  else          console.log("  Mode: READ-ONLY (use --fix-redis to update)");
  console.log("══════════════════════════════════════════════\n");

  // Load all agents from Redis (paginate through entire registry)
  let allAgents: AgentRecord[] = [];
  let offset = 0;
  const pageSize = 100;

  while (true) {
    const page = await listAgents(pageSize, offset);
    if (page.length === 0) break;
    allAgents = allAgents.concat(page);
    offset += pageSize;
    if (page.length < pageSize) break;
  }

  console.log(`Loaded ${allAgents.length} agents from registry\n`);

  if (allAgents.length === 0) {
    console.log("No agents registered. Nothing to verify.");
    return;
  }

  // ── Metrics counters ──────────────────────────────────────────
  let ok            = 0;
  let driftAuth     = 0;  // auth-addr mismatch
  let driftOptIn    = 0;  // USDC not opted in
  let driftBalance  = 0;  // ALGO underfunded
  let ghostRecords  = 0;  // account not found on-chain
  const driftAgents: string[] = [];

  // ── Process each agent ────────────────────────────────────────
  for (let i = 0; i < allAgents.length; i++) {
    const agent = allAgents[i];

    if (i > 0 && i % 50 === 0) {
      console.log(`  Progress: ${i}/${allAgents.length}...`);
    }

    let accountInfo: Awaited<ReturnType<typeof algod.accountInformation>> extends
      { do(): Promise<infer T> } ? T : never;

    try {
      accountInfo = await algod.accountInformation(agent.address).do();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no accounts found") || msg.includes("404")) {
        console.warn(
          `  [GHOST] ${agent.agentId} — address ${agent.address} not found on-chain`,
        );
        ghostRecords++;
        driftAgents.push(agent.agentId);

        await storeDrift({
          agentId:         agent.agentId,
          address:         agent.address,
          expectedAuthAddr: agent.authAddr,
          actualAuthAddr:  null,
          usdcOptedIn:     false,
          microAlgoBalance: 0,
          detectedAt:      new Date().toISOString(),
        });
      } else {
        console.error(`  [ERROR] ${agent.agentId}: Algod lookup failed — ${msg}`);
      }
      await sleep(ALGOD_DELAY_MS);
      continue;
    }

    // ── Check 1: auth-addr (rekey relationship) ─────────────
    const onChainAuth    = accountInfo.authAddr?.toString() ?? null;
    const authAddrDrift  = onChainAuth !== agent.authAddr;

    if (authAddrDrift) {
      console.warn(
        `  [DRIFT-AUTH] ${agent.agentId}\n` +
        `    Registry: ${agent.authAddr}\n` +
        `    On-chain: ${onChainAuth ?? "(not rekeyed)"}`,
      );
      driftAuth++;
      driftAgents.push(agent.agentId);
    }

    // ── Check 2: USDC opt-in ─────────────────────────────────
    const assets       = accountInfo.assets ?? [];
    const usdcOptedIn  = assets.some(
      (a: { assetId: bigint }) => a.assetId === USDC_ASSET_ID,
    );

    if (!usdcOptedIn) {
      console.warn(`  [DRIFT-OPTIN] ${agent.agentId} — not opted into USDC ASA ${USDC_ASSET_ID}`);
      driftOptIn++;
      if (!driftAgents.includes(agent.agentId)) driftAgents.push(agent.agentId);
    }

    // ── Check 3: ALGO balance ────────────────────────────────
    const algoBalance   = Number(accountInfo.amount ?? 0);
    const underfunded   = algoBalance < MIN_ALGO_BALANCE;

    if (underfunded) {
      console.warn(
        `  [DRIFT-BALANCE] ${agent.agentId} — ` +
        `${algoBalance} microALGO < ${MIN_ALGO_BALANCE} minimum`,
      );
      driftBalance++;
      if (!driftAgents.includes(agent.agentId)) driftAgents.push(agent.agentId);
    }

    // ── Write drift record if any anomaly found ──────────────
    const hasDrift = authAddrDrift || !usdcOptedIn || underfunded;

    if (hasDrift) {
      await storeDrift({
        agentId:          agent.agentId,
        address:          agent.address,
        expectedAuthAddr: agent.authAddr,
        actualAuthAddr:   onChainAuth,
        usdcOptedIn,
        microAlgoBalance: algoBalance,
        detectedAt:       new Date().toISOString(),
      });

      // --fix-redis: update Registry authAddr to match on-chain truth
      if (fixRedis && authAddrDrift && onChainAuth) {
        await updateAgentRecord({ ...agent, authAddr: onChainAuth });
        console.log(
          `  [FIX] ${agent.agentId} registry authAddr updated → ${onChainAuth}`,
        );
      }
    } else {
      ok++;
      // Clear any previously recorded drift that is now resolved
      await resolveDrift(agent.agentId);
    }

    await sleep(ALGOD_DELAY_MS);
  }

  // ── Summary ───────────────────────────────────────────────────
  const total = allAgents.length;
  console.log("\n══════════════════════════════════════════════");
  console.log("  Verification Summary");
  console.log("══════════════════════════════════════════════");
  console.log(`  Total agents:    ${total}`);
  console.log(`  Clean:           ${ok}`);
  console.log(`  Auth-addr drift: ${driftAuth}`);
  console.log(`  Missing opt-in:  ${driftOptIn}`);
  console.log(`  Underfunded:     ${driftBalance}`);
  console.log(`  Ghost records:   ${ghostRecords}`);
  console.log(`  Total with drift:${driftAgents.length}`);
  console.log("══════════════════════════════════════════════");

  // ── Remediation guidance ──────────────────────────────────────
  if (driftAuth > 0) {
    console.log("\nAuth-addr drift remediation:");
    console.log("  1. If rotation is in progress: run `rotate-signer status --batch <id>`");
    console.log("  2. If unexpected: run `recover-orphans --fix-registry-drift`");
    console.log("  3. Use --fix-redis to update registry to match on-chain truth");
  }

  if (driftOptIn > 0) {
    console.log("\nMissing USDC opt-in remediation:");
    console.log("  Run `recover-orphans --fix-optin` to submit opt-in txns");
    console.log("  (requires Rocca signer to sign — agent is rekeyed to Rocca)");
  }

  if (driftBalance > 0) {
    console.log("\nUnderfunded agents remediation:");
    console.log("  Transfer ALGO from Rocca signer to each underfunded address");
  }

  if (ghostRecords > 0) {
    console.log("\nGhost records (address not on-chain):");
    console.log("  These agents were never confirmed on-chain or the address was closed out.");
    console.log("  Run `recover-orphans --re-register` to create new on-chain accounts.");
  }

  // Exit 1 if drift found — allows CI/monitoring to detect issues
  if (driftAgents.length > 0) {
    console.log(
      `\n[verify-registry] FAILED: ${driftAgents.length} agents have drift. ` +
      "Drift records written to Redis (x402:drift:*).\n",
    );
    process.exit(1);
  } else {
    console.log("\n[verify-registry] PASSED: registry is in sync with on-chain state.\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("\n[verify-registry] FAILED:", err.message);
  process.exit(1);
});
