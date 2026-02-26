#!/usr/bin/env tsx
/**
 * recover-orphans — Orphan recovery for the agent registry
 *
 * Two recovery strategies:
 *
 *   Strategy A — Chain orphans (--scan-chain)
 *     Query Algorand indexer for ALL accounts with auth-addr = Rocca signer.
 *     Cross-reference against Redis registry.
 *     Accounts on-chain but not in Redis = orphans that slipped through
 *     (e.g. registration group confirmed but Redis write failed).
 *     Action: create a registry record with a synthetic agentId.
 *
 *   Strategy B — Registry drift (--fix-registry-drift)
 *     Read Redis agents flagged in x402:drift:*.
 *     For auth-addr drift where the on-chain auth-addr = Rocca signer:
 *       the account is still under our control — just fix the Redis record.
 *     For auth-addr drift where on-chain auth-addr ≠ Rocca signer:
 *       the account has been rekeyed away — flag for manual investigation.
 *
 *   Strategy C — Fix USDC opt-in (--fix-optin)
 *     For drifted agents missing USDC opt-in: submit opt-in txn.
 *     Since the agent is rekeyed to Rocca signer, Rocca can sign.
 *
 * Usage:
 *   npx tsx scripts/recover-orphans.ts --scan-chain
 *   npx tsx scripts/recover-orphans.ts --fix-registry-drift
 *   npx tsx scripts/recover-orphans.ts --fix-optin
 *   npx tsx scripts/recover-orphans.ts --scan-chain --dry-run
 *
 * Required env vars:
 *   ALGO_SIGNER_MNEMONIC      — Rocca signer (signs opt-in txns and recovery txns)
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   ALGORAND_NODE_URL
 *   ALGORAND_INDEXER_URL      — defaults to Nodely mainnet indexer
 */

import "dotenv/config";
import algosdk from "algosdk";
import { getAlgodClient, getIndexerClient } from "../src/network/nodely.js";
import {
  getAgentByAddress,
  storeAgent,
  updateAgentRecord,
  listDrifts,
  resolveDrift,
  assignCohort,
  type AgentRecord,
} from "../src/services/agentRegistry.js";

const USDC_ASSET_ID       = BigInt(process.env.X402_USDC_ASSET_ID ?? "31566704");
const ALGOD_DELAY_MS      = 150;
const INDEXER_PAGE_LIMIT  = 1000;

function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); }
  return v!;
}

function getSignerAccount(): algosdk.Account {
  return algosdk.mnemonicToSecretKey(requireEnv("ALGO_SIGNER_MNEMONIC"));
}

// ── Strategy A: Scan chain for accounts rekeyed to our signer ────

async function scanChain(dryRun: boolean): Promise<void> {
  const signer    = getSignerAccount();
  const signerAddr = signer.addr.toString();
  const indexer   = getIndexerClient();

  console.log(`\n[Strategy A] Scanning chain for accounts with auth-addr = ${signerAddr}`);
  console.log(`[Strategy A] Dry run: ${dryRun}\n`);

  // Algorand indexer v2 supports filtering accounts by auth-addr
  let nextToken: string | undefined;
  let totalScanned  = 0;
  let orphansFound  = 0;
  let orphansFixed  = 0;

  do {
    const params: Record<string, string | number> = {
      "auth-addr": signerAddr,
      limit: INDEXER_PAGE_LIMIT,
    };
    if (nextToken) params["next"] = nextToken;

    // Build query string
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const resp = await fetch(
      `${process.env.ALGORAND_INDEXER_URL ?? "https://mainnet-idx.4160.nodely.dev"}/v2/accounts?${qs}`,
    );

    if (!resp.ok) {
      throw new Error(`Indexer accounts query failed: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json() as {
      accounts: Array<{ address: string; amount: number; assets?: Array<{ "asset-id": number }> }>;
      "next-token"?: string;
    };

    nextToken = data["next-token"];

    for (const acct of data.accounts) {
      totalScanned++;

      // Check if this address is in our Redis registry
      const existing = await getAgentByAddress(acct.address);

      if (existing) {
        // Known agent — skip
        continue;
      }

      // Orphan: on-chain with our auth-addr but not in registry
      orphansFound++;
      console.log(`  [ORPHAN] ${acct.address} — on-chain, not in registry`);
      console.log(`    ALGO balance: ${acct.amount} microALGO`);

      const usdcOptedIn = (acct.assets ?? []).some(
        (a) => a["asset-id"] === Number(USDC_ASSET_ID),
      );
      console.log(`    USDC opted in: ${usdcOptedIn}`);

      if (!dryRun) {
        // Create a synthetic agentId — prefixed so it's clearly a recovered orphan
        const syntheticId = `recovered-${acct.address.slice(0, 8).toLowerCase()}`;
        const cohort       = assignCohort(syntheticId);

        const record: AgentRecord = {
          agentId:            syntheticId,
          address:            acct.address,
          cohort,
          authAddr:           signerAddr,
          platform:           "recovered",
          createdAt:          new Date().toISOString(),
          registrationTxnId:  "orphan-recovery",
          status:             "registered",
        };

        await storeAgent(record);
        orphansFixed++;
        console.log(`    → Registered as agentId: ${syntheticId}`);
      }

      await sleep(ALGOD_DELAY_MS);
    }

  } while (nextToken);

  console.log(`\n[Strategy A] Summary:`);
  console.log(`  Accounts scanned: ${totalScanned}`);
  console.log(`  Orphans found:    ${orphansFound}`);
  console.log(`  Orphans fixed:    ${orphansFixed}`);

  if (orphansFound > 0 && dryRun) {
    console.log("\n  Re-run without --dry-run to create registry records for orphans.");
  }
}

// ── Strategy B: Fix Redis drift records ───────────────────────────

async function fixRegistryDrift(dryRun: boolean): Promise<void> {
  const signer     = getSignerAccount();
  const signerAddr = signer.addr.toString();
  const algod      = getAlgodClient();

  console.log("\n[Strategy B] Fixing Redis drift records");
  console.log(`[Strategy B] Rocca signer: ${signerAddr}`);
  console.log(`[Strategy B] Dry run: ${dryRun}\n`);

  const drifts = await listDrifts();

  if (!drifts.length) {
    console.log("No drift records found. Run verify-registry.ts first.");
    return;
  }

  let fixed       = 0;
  let external    = 0;  // rekeyed away from us — cannot recover automatically
  let ghostCount  = 0;

  for (const drift of drifts) {
    if (drift.resolvedAt) {
      // Already resolved
      continue;
    }

    console.log(`\n  Agent: ${drift.agentId} (${drift.address})`);
    console.log(`    Expected auth-addr: ${drift.expectedAuthAddr}`);
    console.log(`    Actual auth-addr:   ${drift.actualAuthAddr ?? "(not rekeyed)"}`);

    if (drift.actualAuthAddr === null) {
      // Ghost or not-rekeyed account
      console.log(`    → Ghost/not-rekeyed. Manual investigation required.`);
      ghostCount++;
      continue;
    }

    if (drift.actualAuthAddr === signerAddr) {
      // On-chain auth-addr IS our signer but registry has a different address.
      // This happens if the registry was stale from a rotation.
      // Safe to fix: update registry authAddr to match on-chain.
      if (!dryRun) {
        const agent = await import("../src/services/agentRegistry.js").then(
          (m) => m.getAgent(drift.agentId),
        );
        if (agent) {
          await updateAgentRecord({ ...agent, authAddr: signerAddr });
          await resolveDrift(drift.agentId);
          fixed++;
          console.log(`    → Fixed: registry authAddr updated to ${signerAddr}`);
        }
      } else {
        console.log(`    → [DRY RUN] Would update registry authAddr to ${signerAddr}`);
        fixed++;
      }
      continue;
    }

    // On-chain auth-addr is some OTHER address — account rekeyed away from us.
    // This is adversarial or an out-of-band rekey. Cannot recover automatically.
    console.log(
      `    → EXTERNAL REKEY DETECTED: auth-addr is ${drift.actualAuthAddr}`,
    );
    console.log(
      "    → This account is no longer under Rocca control. " +
      "Investigate immediately. Mark agent suspended.",
    );

    const algodInfo = await algod.accountInformation(drift.address).do();
    console.log(`    → On-chain balance: ${algodInfo.amount} microALGO`);

    if (!dryRun) {
      // Suspend the agent — it cannot be trusted for signing
      const { getAgent, updateAgentRecord: update } = await import("../src/services/agentRegistry.js");
      const agent = await getAgent(drift.agentId);
      if (agent && agent.status !== "suspended") {
        await update({ ...agent, status: "suspended" });
        console.log(`    → Agent ${drift.agentId} suspended.`);
      }
    }

    external++;
  }

  console.log(`\n[Strategy B] Summary:`);
  console.log(`  Drift records processed: ${drifts.length}`);
  console.log(`  Fixed (registry updated): ${fixed}`);
  console.log(`  External rekey (manual):  ${external}`);
  console.log(`  Ghost/not-rekeyed:        ${ghostCount}`);

  if (external > 0) {
    console.error(
      `\n  ⚠  ${external} agents have been rekeyed to an external address. ` +
      "Treat as a security incident. Review on Allo.info immediately.",
    );
    process.exit(1);
  }
}

// ── Strategy C: Fix missing USDC opt-in ──────────────────────────

async function fixOptIn(dryRun: boolean): Promise<void> {
  const signer     = getSignerAccount();
  const signerAddr = signer.addr.toString();
  const algod      = getAlgodClient();

  console.log("\n[Strategy C] Fixing missing USDC opt-ins");
  console.log(`[Strategy C] Dry run: ${dryRun}\n`);

  const drifts       = await listDrifts();
  const missingOptIn = drifts.filter((d) => !d.usdcOptedIn && !d.resolvedAt);

  if (!missingOptIn.length) {
    console.log("No agents missing USDC opt-in. Nothing to fix.");
    return;
  }

  console.log(`Found ${missingOptIn.length} agents missing USDC opt-in\n`);

  let fixed  = 0;
  let failed = 0;

  const params = await algod.getTransactionParams().do();

  for (const drift of missingOptIn) {
    console.log(`  ${drift.agentId} (${drift.address})`);

    if (drift.actualAuthAddr !== signerAddr && drift.actualAuthAddr !== null) {
      console.log(
        `    Skipping: auth-addr ${drift.actualAuthAddr} ≠ Rocca signer — cannot sign`,
      );
      continue;
    }

    if (dryRun) {
      console.log("    [DRY RUN] Would submit USDC opt-in txn");
      fixed++;
      continue;
    }

    try {
      // Rocca signer is the auth-addr, so it can sign this opt-in on behalf of the agent
      const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender:          drift.address,
        receiver:        drift.address,
        amount:          0n,
        assetIndex:      USDC_ASSET_ID,
        suggestedParams: params,
        note:            new Uint8Array(
          Buffer.from(`x402:recover-optin:${drift.agentId}`),
        ),
      });

      // Signer signs on behalf of the agent (auth-addr relationship)
      const signed   = optInTxn.signTxn(signer.sk);
      const { txid } = await algod.sendRawTransaction(signed).do();
      await algosdk.waitForConfirmation(algod, txid, 4);

      console.log(`    Opt-in confirmed: ${txid}`);
      fixed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    FAILED: ${msg}`);
      failed++;
    }

    await sleep(ALGOD_DELAY_MS);
  }

  console.log(`\n[Strategy C] Summary: ${fixed} fixed, ${failed} failed`);
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun            = flag("dry-run");
  const doScanChain       = flag("scan-chain");
  const doFixRegistryDrift = flag("fix-registry-drift");
  const doFixOptIn        = flag("fix-optin");

  if (!doScanChain && !doFixRegistryDrift && !doFixOptIn) {
    console.log(`
Usage:
  npx tsx scripts/recover-orphans.ts --scan-chain           [--dry-run]
  npx tsx scripts/recover-orphans.ts --fix-registry-drift   [--dry-run]
  npx tsx scripts/recover-orphans.ts --fix-optin            [--dry-run]

Strategies:
  --scan-chain           Find on-chain accounts with our auth-addr not in Redis
  --fix-registry-drift   Fix Redis records where auth-addr is stale
  --fix-optin            Submit USDC opt-in txns for agents missing it

Use --dry-run to simulate any strategy without submitting transactions.
`);
    process.exit(1);
  }

  if (doScanChain)        await scanChain(dryRun);
  if (doFixRegistryDrift) await fixRegistryDrift(dryRun);
  if (doFixOptIn)         await fixOptIn(dryRun);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("\n[recover-orphans] FAILED:", err.message);
  process.exit(1);
});
