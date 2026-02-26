#!/usr/bin/env tsx
/**
 * rotate-signer — Cohort signer rotation operational script
 *
 * Commands:
 *   start    --cohort A [--batch-size 50] [--confirm-depth 4] [--dry-run]
 *   resume   --batch <batchId>
 *   rollback --batch <batchId>
 *   status   --batch <batchId>
 *   halt     --reason "reason string"
 *   unhalt
 *
 * Required env vars:
 *   ALGO_SIGNER_MNEMONIC      — current/old cohort signer (25 words)
 *   ALGO_NEW_SIGNER_MNEMONIC  — new cohort signer (25 words, must be funded)
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *   ALGORAND_NODE_URL         — defaults to Nodely mainnet
 *
 * Safety:
 *   --dry-run prints what would happen without submitting any txns.
 *   The script refuses to start if x402:halt is set.
 *   The script auto-halts if failure rate exceeds 10% in any sub-batch.
 *   Resume reads the batchId from Redis and skips already-confirmed agents.
 *   Rollback re-keys confirmed agents back to the old signer using the new signer key.
 */

import "dotenv/config";
import algosdk from "algosdk";
import {
  startRotation,
  resumeRotation,
  rollbackRotation,
} from "../src/services/rotationEngine.js";
import {
  getRotationBatch,
  setHalt,
  clearHalt,
  isHalted,
  getRotationDoneSet,
} from "../src/services/agentRegistry.js";

// ── Arg parsing ───────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function requireArg(name: string): string {
  const v = arg(name);
  if (!v) { console.error(`Missing --${name}`); process.exit(1); }
  return v;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); }
  return v!;
}

// ── Command: status ───────────────────────────────────────────────

async function cmdStatus(batchId: string): Promise<void> {
  const batch = await getRotationBatch(batchId);
  if (!batch) { console.error(`Batch not found: ${batchId}`); process.exit(1); }

  const doneCount   = (await getRotationDoneSet(batchId)).length;
  const pctDone     = batch.totalAgents
    ? ((doneCount / batch.totalAgents) * 100).toFixed(1)
    : "0";

  console.log("\n══════════════════════════════════════════");
  console.log("  Rotation Batch Status");
  console.log("══════════════════════════════════════════");
  console.log(`  BatchId:    ${batch.batchId}`);
  console.log(`  Cohort:     ${batch.cohort}`);
  console.log(`  Status:     ${batch.status}`);
  console.log(`  From:       ${batch.fromAuthAddr}`);
  console.log(`  To:         ${batch.toAuthAddr}`);
  console.log(`  Total:      ${batch.totalAgents}`);
  console.log(`  Confirmed:  ${batch.confirmedCount} (${pctDone}%)`);
  console.log(`  Failed:     ${batch.failedCount}`);
  console.log(`  Done set:   ${doneCount}`);
  console.log(`  DryRun:     ${batch.dryRun}`);
  console.log(`  StartedAt:  ${batch.startedAt}`);
  console.log(`  UpdatedAt:  ${batch.updatedAt}`);
  if (batch.completedAt) console.log(`  Completed:  ${batch.completedAt}`);
  if (batch.haltReason)  console.log(`  HaltReason: ${batch.haltReason}`);
  console.log("══════════════════════════════════════════\n");

  const halt = await isHalted();
  if (halt) console.warn(`  ⚠  System halt active: ${halt}`);
}

// ── Command: start ────────────────────────────────────────────────

async function cmdStart(): Promise<void> {
  const cohort        = arg("cohort") ?? "A";
  const batchSize     = parseInt(arg("batch-size") ?? "50", 10);
  const confirmDepth  = parseInt(arg("confirm-depth") ?? "4", 10);
  const dryRun        = flag("dry-run");
  const fromMnemonic  = requireEnv("ALGO_SIGNER_MNEMONIC");
  const toMnemonic    = requireEnv("ALGO_NEW_SIGNER_MNEMONIC");

  // Print new signer address for confirmation
  const toAccount = algosdk.mnemonicToSecretKey(toMnemonic);
  const fromAccount = algosdk.mnemonicToSecretKey(fromMnemonic);

  console.log("\n══════════════════════════════════════════");
  console.log("  Signer Rotation — PRE-FLIGHT");
  console.log("══════════════════════════════════════════");
  console.log(`  Cohort:         ${cohort}`);
  console.log(`  From signer:    ${fromAccount.addr}`);
  console.log(`  To signer:      ${toAccount.addr}`);
  console.log(`  Batch size:     ${batchSize}`);
  console.log(`  Confirm depth:  ${confirmDepth} rounds`);
  console.log(`  Dry run:        ${dryRun}`);
  console.log("══════════════════════════════════════════");

  if (!dryRun) {
    console.log("\n⚠  This will submit on-chain transactions and modify agent auth-addr.");
    console.log("   Interrupt now (Ctrl+C) to abort. Continuing in 5 seconds...\n");
    await sleep(5000);
  }

  const batchId = await startRotation({
    cohort,
    fromMnemonic,
    toMnemonic,
    batchSize,
    minConfirmDepth: confirmDepth,
    dryRun,
  });

  console.log(`\n[rotate-signer] Rotation complete. BatchId: ${batchId}`);
  await cmdStatus(batchId);
}

// ── Command: resume ───────────────────────────────────────────────

async function cmdResume(): Promise<void> {
  const batchId      = requireArg("batch");
  const fromMnemonic = requireEnv("ALGO_SIGNER_MNEMONIC");
  const toMnemonic   = requireEnv("ALGO_NEW_SIGNER_MNEMONIC");

  console.log(`[rotate-signer] Resuming rotation ${batchId}...`);
  await resumeRotation(batchId, fromMnemonic, toMnemonic);
  await cmdStatus(batchId);
}

// ── Command: rollback ─────────────────────────────────────────────

async function cmdRollback(): Promise<void> {
  const batchId    = requireArg("batch");
  const newMnemonic = requireEnv("ALGO_NEW_SIGNER_MNEMONIC");

  const batch = await getRotationBatch(batchId);
  if (!batch) { console.error(`Batch not found: ${batchId}`); process.exit(1); }

  const doneCount = (await getRotationDoneSet(batchId)).length;

  console.log("\n══════════════════════════════════════════");
  console.log("  Rotation Rollback");
  console.log("══════════════════════════════════════════");
  console.log(`  BatchId:    ${batchId}`);
  console.log(`  Re-keying:  ${doneCount} agents`);
  console.log(`  Back to:    ${batch.fromAuthAddr}`);
  console.log(`  Signing as: ${batch.toAuthAddr} (current auth-addr)`);
  console.log("══════════════════════════════════════════");
  console.log("\n⚠  This submits on-chain transactions. Continuing in 5 seconds...\n");
  await sleep(5000);

  await rollbackRotation(batchId, newMnemonic);
  console.log("[rotate-signer] Rollback complete.");
}

// ── Command: halt / unhalt ────────────────────────────────────────

async function cmdHalt(): Promise<void> {
  const reason = arg("reason") ?? "Manual halt via rotate-signer script";
  await setHalt(reason);
  console.log(`[rotate-signer] Emergency halt set: ${reason}`);
}

async function cmdUnhalt(): Promise<void> {
  await clearHalt();
  console.log("[rotate-signer] Halt cleared. System is operational.");
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cmd = process.argv[2];

  switch (cmd) {
    case "start":    await cmdStart();                    break;
    case "resume":   await cmdResume();                   break;
    case "rollback": await cmdRollback();                 break;
    case "status":   await cmdStatus(requireArg("batch")); break;
    case "halt":     await cmdHalt();                     break;
    case "unhalt":   await cmdUnhalt();                   break;
    default:
      console.log(`
Usage:
  npx tsx scripts/rotate-signer.ts start    --cohort A [--dry-run] [--batch-size 50]
  npx tsx scripts/rotate-signer.ts resume   --batch <batchId>
  npx tsx scripts/rotate-signer.ts rollback --batch <batchId>
  npx tsx scripts/rotate-signer.ts status   --batch <batchId>
  npx tsx scripts/rotate-signer.ts halt     --reason "emergency"
  npx tsx scripts/rotate-signer.ts unhalt

Required env vars:
  ALGO_SIGNER_MNEMONIC      current cohort signer
  ALGO_NEW_SIGNER_MNEMONIC  new cohort signer (must have ALGO for fees)
`);
      process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("\n[rotate-signer] FAILED:", err.message);
  process.exit(1);
});
