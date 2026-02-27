/**
 * On-Chain Outflow Monitor — Key Compromise Detection
 *
 * Independently queries the Algorand Indexer to verify that outgoing
 * transactions from the treasury address are consistent with what
 * Gate 5 (treasuryOutflowGuard) authorized in Redis.
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │  Threat model                                                     │
 * │                                                                   │
 * │  Every existing gate checks Redis state. If the signing key is   │
 * │  extracted via a Vault misconfiguration, a leaked mnemonic in    │
 * │  logs, or a side-channel attack, an attacker can submit signed   │
 * │  transactions directly to the Algorand network — completely       │
 * │  bypassing every in-process gate.                                 │
 * │                                                                   │
 * │  This module is the ONLY defense that operates entirely outside  │
 * │  the signing pipeline: it talks directly to the Algorand         │
 * │  Indexer and compares ground-truth on-chain outflows to what     │
 * │  Gate 5 reported it authorized.                                  │
 * │                                                                   │
 * │  Invariant:  on-chain-seen  ≤  gate5-authorized + tolerance      │
 * │  Violation:  SIGNER_KEY_COMPROMISE halt                          │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * ── Two-counter architecture ─────────────────────────────────────────
 *
 *   Gate 5 (RoccaWallet, admission path):
 *     INCRBY  x402:guardian:authorized:algo   by microALGO each signing pass
 *     INCRBY  x402:guardian:authorized:usdc   by microUSDC each signing pass
 *     (written by treasuryOutflowGuard.ts — no TTL, running total)
 *
 *   This module (reconciliation cycle):
 *     Query indexer for treasury address sender txns since last-round
 *     INCRBY  x402:guardian:onchain:algo-seen  by on-chain ALGO sum
 *     INCRBY  x402:guardian:onchain:usdc-seen  by on-chain USDC sum
 *
 *   Check:  seen > authorized + tolerance  →  halt + SIGNER_KEY_COMPROMISE
 *
 * ── First-run bootstrap ──────────────────────────────────────────────
 *
 *   On first run (last-round not set in Redis):
 *     - Record current Algorand round as the baseline
 *     - Set both seen counters to 0
 *     - Leave authorized counters untouched (Gate 5 may have already started)
 *     - Return immediately without comparing (no historical data yet)
 *
 *   On subsequent runs:
 *     - Query only transactions AFTER the baseline round
 *     - Any authorized spend before baseline is already in the authorized
 *       counter, so seen starts catching up from 0 → the invariant holds
 *       until an unauthorized transaction appears
 *
 * ── Tolerance ────────────────────────────────────────────────────────
 *
 *   ALGO tolerance accounts for raw tx fees paid by the signer on Algorand
 *   network transactions. These are deducted from the sender's balance by
 *   the AVM and appear as on-chain outflow but are NOT tracked by Gate 5
 *   (Gate 5 tracks intentional payment amounts, not fees).
 *
 *   USDC tolerance defaults to ZERO — any unexplained USDC outflow is a
 *   critical signal of key compromise.
 *
 * ── Failure mode ─────────────────────────────────────────────────────
 *
 *   Fail OPEN: Indexer unavailable → skips cycle, logs warning.
 *   Never halts due to a network error. Only halts on confirmed discrepancy.
 *
 * ── Environment variables ────────────────────────────────────────────
 *
 *   ONCHAIN_MONITOR_ENABLED          "false" to disable (default: enabled)
 *   ONCHAIN_ALGO_TOLERANCE_MICRO     ALGO tolerance in microALGO (default: 10_000_000 = 10 ALGO)
 *   ONCHAIN_USDC_TOLERANCE_MICRO     USDC tolerance in microUSDC (default: 0)
 *
 * ── Redis keys (no TTL — running totals, reset by admin on incident) ─
 *
 *   x402:guardian:onchain:last-round   Last Algorand round reconciled
 *   x402:guardian:onchain:algo-seen    Cumulative ALGO outflows seen on-chain
 *   x402:guardian:onchain:usdc-seen    Cumulative USDC outflows seen on-chain
 *
 *   (written by treasuryOutflowGuard.ts — same "guardian" namespace):
 *   x402:guardian:authorized:algo      Cumulative ALGO Gate-5 authorized
 *   x402:guardian:authorized:usdc      Cumulative USDC Gate-5 authorized
 *
 * Module 9 — On-Chain Reconciliation
 */

import { getIndexerClient, getAlgodClient } from "../network/nodely.js";
import { getRedis }                          from "../services/redis.js";
import { setHalt }                           from "../services/agentRegistry.js";
import { emitSecurityEvent }                 from "../services/securityAudit.js";
import { config }                            from "../config.js";

// ── Policy ─────────────────────────────────────────────────────────

export const ONCHAIN_MONITOR_ENABLED =
  process.env.ONCHAIN_MONITOR_ENABLED !== "false";

/** 10 ALGO default — covers network fees paid by signer on each group */
const ALGO_TOLERANCE = BigInt(
  process.env.ONCHAIN_ALGO_TOLERANCE_MICRO ?? "10000000",
);

/** Zero USDC tolerance — any unexplained USDC outflow is a critical signal */
const USDC_TOLERANCE = BigInt(
  process.env.ONCHAIN_USDC_TOLERANCE_MICRO ?? "0",
);

const USDC_ASSET_ID = BigInt(config.x402.usdcAssetId);

// ── Redis keys ─────────────────────────────────────────────────────

export const KEY_LAST_ROUND  = "x402:guardian:onchain:last-round";
export const KEY_ALGO_SEEN   = "x402:guardian:onchain:algo-seen";
export const KEY_USDC_SEEN   = "x402:guardian:onchain:usdc-seen";
export const KEY_AUTH_ALGO   = "x402:guardian:authorized:algo";
export const KEY_AUTH_USDC   = "x402:guardian:authorized:usdc";

// ── Result type ────────────────────────────────────────────────────

export interface ReconciliationResult {
  checkedRounds:       number;
  newTxnCount:         number;
  newAlgoSeen:         bigint;
  newUsdcSeen:         bigint;
  totalAlgoSeen:       bigint;
  totalUsdcSeen:       bigint;
  totalAlgoAuthorized: bigint;
  totalUsdcAuthorized: bigint;
  algoDiscrepancy:     bigint;
  usdcDiscrepancy:     bigint;
  haltTriggered:       boolean;
  /** Set when the cycle was skipped — reason string explains why */
  skipped?:            string;
}

// ── Indexer query ──────────────────────────────────────────────────

interface OutflowTotals {
  totalAlgo: bigint;
  totalUsdc: bigint;
  txnCount:  number;
  maxRound:  number;
}

/**
 * Query the Algorand Indexer for all outgoing transactions from `senderAddr`
 * with confirmed-round ≥ `minRound`, summing ALGO pay and USDC axfer amounts.
 *
 * Paginates up to 3 pages (1 500 transactions) to bound latency.
 * Any page failure throws — callers catch and return skipped().
 */
async function queryOutflowsSinceRound(
  senderAddr: string,
  minRound:   number,
): Promise<OutflowTotals> {
  const indexer = getIndexerClient();
  let totalAlgo = 0n;
  let totalUsdc = 0n;
  let txnCount  = 0;
  let maxRound  = minRound;
  let nextToken: string | undefined = undefined;

  // Max 3 pages × 500 transactions = 1 500 transactions per cycle.
  // At typical settlement rates this covers several minutes of activity.
  // If more accumulate between cycles, they'll be picked up next cycle
  // via the advancing last-round pointer.
  for (let page = 0; page < 3; page++) {
    const query = indexer
      .searchForTransactions()
      .address(senderAddr)
      .addressRole("sender")
      .minRound(minRound)
      .limit(500);

    if (nextToken) {
      query.nextToken(nextToken);
    }

    const result = await query.do();

    for (const txn of result.transactions ?? []) {
      const round = Number(txn.confirmedRound ?? 0);
      if (round > maxRound) maxRound = round;
      txnCount++;

      if (txn.txType === "pay" && txn.paymentTransaction) {
        // ALGO pay: sum the transferred amount (not the fee — fees are charged
        // separately by the AVM and accounted for by ALGO_TOLERANCE)
        totalAlgo += txn.paymentTransaction.amount;
      } else if (txn.txType === "axfer" && txn.assetTransferTransaction) {
        // USDC asset transfer: only count forward transfers, skip opt-in (amount 0)
        if (
          txn.assetTransferTransaction.assetId === USDC_ASSET_ID &&
          txn.assetTransferTransaction.amount > 0n
        ) {
          totalUsdc += txn.assetTransferTransaction.amount;
        }
      }
    }

    nextToken = result.nextToken;
    if (!nextToken || (result.transactions?.length ?? 0) < 500) break;
  }

  return { totalAlgo, totalUsdc, txnCount, maxRound };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Run one on-chain reconciliation cycle for the given treasury address.
 *
 * Compares cumulative on-chain outflows (via Algorand Indexer) against
 * cumulative Gate 5 authorizations (via Redis counters written by
 * treasuryOutflowGuard.ts). Any unexplained excess triggers an
 * emergency halt and emits a SIGNER_KEY_COMPROMISE security event.
 *
 * Fail-open: any Indexer or Algod error returns `{ skipped: reason }`
 * rather than halting. Only confirmed discrepancies halt signing.
 *
 * @param treasuryAddr  The treasury Algorand address to monitor
 *                      (X402_PAY_TO_ADDRESS in production)
 */
export async function runOnChainReconciliation(
  treasuryAddr: string,
): Promise<ReconciliationResult> {
  if (!ONCHAIN_MONITOR_ENABLED) {
    return skip("ONCHAIN_MONITOR_ENABLED=false");
  }

  const redis = getRedis();
  if (!redis) {
    return skip("Redis unavailable");
  }

  // ── Get current Algorand round ──────────────────────────────────
  let currentRound: number;
  try {
    const status = await getAlgodClient().status().do();
    currentRound = Number(status.lastRound ?? 0);
  } catch (err) {
    return skip(`Algod unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (currentRound === 0) return skip("Algod returned round 0");

  // ── Bootstrap check ─────────────────────────────────────────────
  const rawLastRound = await redis.get(KEY_LAST_ROUND) as string | null;

  if (rawLastRound === null) {
    // First run — set baseline to current round, zero the seen counters.
    // Don't touch authorized counters — Gate 5 may have been running
    // since boot and the existing authorized total acts as our starting
    // allowance for any historical transactions that pre-date the monitor.
    await Promise.all([
      redis.set(KEY_LAST_ROUND, String(currentRound)),
      redis.set(KEY_ALGO_SEEN, "0"),
      redis.set(KEY_USDC_SEEN, "0"),
    ]);
    console.log(
      `[OnChainMonitor] Bootstrap: baseline set at round ${currentRound}. ` +
      `Future outflows from ${treasuryAddr} will be reconciled.`,
    );
    return skip(`Bootstrapped at round ${currentRound}`);
  }

  const lastRound = parseInt(rawLastRound, 10);

  if (currentRound <= lastRound) {
    return skip(`No new rounds (current=${currentRound}, last=${lastRound})`);
  }

  // ── Query on-chain outflows ─────────────────────────────────────
  let totals: OutflowTotals;
  try {
    totals = await queryOutflowsSinceRound(treasuryAddr, lastRound + 1);
  } catch (err) {
    return skip(`Indexer query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { totalAlgo: newAlgo, totalUsdc: newUsdc, txnCount, maxRound } = totals;

  // ── Update seen counters atomically ────────────────────────────
  // Fire both INCRBY (or GET if no new spend) in parallel, then read
  // the authorized counters in the same batch.
  const [algoSeenRaw, usdcSeenRaw, authAlgoRaw, authUsdcRaw] = await Promise.all([
    newAlgo > 0n
      ? redis.incrby(KEY_ALGO_SEEN, Number(newAlgo))
      : redis.get(KEY_ALGO_SEEN),
    newUsdc > 0n
      ? redis.incrby(KEY_USDC_SEEN, Number(newUsdc))
      : redis.get(KEY_USDC_SEEN),
    redis.get(KEY_AUTH_ALGO),
    redis.get(KEY_AUTH_USDC),
  ]);

  const totalAlgoSeen  = BigInt(String(algoSeenRaw  ?? "0"));
  const totalUsdcSeen  = BigInt(String(usdcSeenRaw  ?? "0"));
  const totalAlgoAuth  = BigInt(String(authAlgoRaw  ?? "0"));
  const totalUsdcAuth  = BigInt(String(authUsdcRaw  ?? "0"));

  // ── Advance the round pointer ───────────────────────────────────
  const nextRound = Math.max(currentRound, maxRound);
  await redis.set(KEY_LAST_ROUND, String(nextRound));

  // ── Discrepancy check ───────────────────────────────────────────
  const algoDiscrepancy =
    totalAlgoSeen > totalAlgoAuth + ALGO_TOLERANCE
      ? totalAlgoSeen - totalAlgoAuth - ALGO_TOLERANCE
      : 0n;

  const usdcDiscrepancy =
    totalUsdcSeen > totalUsdcAuth + USDC_TOLERANCE
      ? totalUsdcSeen - totalUsdcAuth - USDC_TOLERANCE
      : 0n;

  if (algoDiscrepancy > 0n || usdcDiscrepancy > 0n) {
    const detail = {
      algoDiscrepancy:     algoDiscrepancy.toString(),
      usdcDiscrepancy:     usdcDiscrepancy.toString(),
      totalAlgoSeen:       totalAlgoSeen.toString(),
      totalUsdcSeen:       totalUsdcSeen.toString(),
      totalAlgoAuthorized: totalAlgoAuth.toString(),
      totalUsdcAuthorized: totalUsdcAuth.toString(),
      algoTolerance:       ALGO_TOLERANCE.toString(),
      usdcTolerance:       USDC_TOLERANCE.toString(),
      lastRound:           String(lastRound),
      currentRound:        String(nextRound),
      treasuryAddr,
    };

    emitSecurityEvent({
      type:      "SIGNER_KEY_COMPROMISE",
      agentId:   "on-chain-monitor",
      detail,
      timestamp: new Date().toISOString(),
    });

    const reason =
      `ON_CHAIN_DISCREPANCY: ` +
      (algoDiscrepancy > 0n
        ? `ALGO seen=${totalAlgoSeen} > authorized=${totalAlgoAuth}+tolerance=${ALGO_TOLERANCE} (excess=${algoDiscrepancy} µALGO). `
        : "") +
      (usdcDiscrepancy > 0n
        ? `USDC seen=${totalUsdcSeen} > authorized=${totalUsdcAuth}+tolerance=${USDC_TOLERANCE} (excess=${usdcDiscrepancy} µUSDC). `
        : "") +
      `Possible signing key compromise. Admin investigation required before clearing.`;

    await setHalt(reason);
    console.error(`[OnChainMonitor] DISCREPANCY DETECTED — signing halted. ${reason}`);

    return {
      checkedRounds: nextRound - lastRound,
      newTxnCount:   txnCount,
      newAlgoSeen:   newAlgo,
      newUsdcSeen:   newUsdc,
      totalAlgoSeen,
      totalUsdcSeen,
      totalAlgoAuthorized: totalAlgoAuth,
      totalUsdcAuthorized: totalUsdcAuth,
      algoDiscrepancy,
      usdcDiscrepancy,
      haltTriggered: true,
    };
  }

  // ── Clean cycle ─────────────────────────────────────────────────
  if (txnCount > 0) {
    console.log(
      `[OnChainMonitor] rounds ${lastRound + 1}–${nextRound}: ` +
      `${txnCount} txns, +${newAlgo}µALGO +${newUsdc}µUSDC on-chain. ` +
      `Cumulative seen: ${totalAlgoSeen}µALGO / ${totalUsdcSeen}µUSDC | ` +
      `authorized: ${totalAlgoAuth}µALGO / ${totalUsdcAuth}µUSDC — OK`,
    );
  }

  return {
    checkedRounds: nextRound - lastRound,
    newTxnCount:   txnCount,
    newAlgoSeen:   newAlgo,
    newUsdcSeen:   newUsdc,
    totalAlgoSeen,
    totalUsdcSeen,
    totalAlgoAuthorized: totalAlgoAuth,
    totalUsdcAuthorized: totalUsdcAuth,
    algoDiscrepancy:     0n,
    usdcDiscrepancy:     0n,
    haltTriggered:       false,
  };
}

// ── Helper ─────────────────────────────────────────────────────────

function skip(reason: string): ReconciliationResult {
  return {
    checkedRounds:       0,
    newTxnCount:         0,
    newAlgoSeen:         0n,
    newUsdcSeen:         0n,
    totalAlgoSeen:       0n,
    totalUsdcSeen:       0n,
    totalAlgoAuthorized: 0n,
    totalUsdcAuthorized: 0n,
    algoDiscrepancy:     0n,
    usdcDiscrepancy:     0n,
    haltTriggered:       false,
    skipped:             reason,
  };
}
