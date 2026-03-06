/**
 * Gas Station — Autonomous ALGO Reserve Top-Up
 *
 * Monitors registered agent ALGO balances on a configurable interval.
 * When an agent's balance drops below the trigger threshold, the gas station
 * sends a top-up directly from the treasury wallet — no agent action required.
 *
 * Why server-side, not agent-side:
 *   The agent needs ALGO to send a self-refill request. If it's nearly out of ALGO,
 *   it may not have enough to pay that fee — circular dependency. The server has no
 *   such constraint: it controls the treasury and pushes top-ups proactively.
 *
 * Trigger threshold:  0.21 ALGO (MBR 0.20 + 10-tx safety buffer 0.01)
 * Top-up amount:      0.70 ALGO above MBR → ~700 additional payment transactions
 *
 * Environment variables:
 *   ALGO_TREASURY_MNEMONIC      25-word mnemonic of the treasury wallet (required)
 *   GAS_STATION_ENABLED         Set to "false" to disable (default: "true")
 *   GAS_STATION_INTERVAL_S      Poll interval in seconds (default: 120)
 *   GAS_STATION_TRIGGER_MICRO   µALGO threshold that triggers a top-up (default: 210000)
 *   GAS_STATION_TOPUP_MICRO     µALGO to send per top-up (default: 700000)
 */

import algosdk from "algosdk";
import { getAlgodClient, getSuggestedParams } from "../network/nodely.js";
import { scanAllAgents, isHalted } from "./agentRegistry.js";
import { checkAndRecordOutflow, rollbackOutflow } from "../protection/treasuryOutflowGuard.js";
import { getRedis } from "./redis.js";

const ENABLED          = process.env.GAS_STATION_ENABLED !== "false";
const INTERVAL_MS      = parseInt(process.env.GAS_STATION_INTERVAL_S    ?? "30",  10) * 1_000;
const TRIGGER_MICRO    = BigInt(process.env.GAS_STATION_TRIGGER_MICRO ?? "500000"); // 0.50 ALGO
const TOPUP_MICRO      = BigInt(process.env.GAS_STATION_TOPUP_MICRO   ?? "700000"); // 0.70 ALGO
// Minimum treasury balance required before any top-up is attempted:
// MBR (0.1 ALGO) + one full top-up amount + transaction fee buffer
const TREASURY_MIN_MICRO = 100_000n + TOPUP_MICRO + 2_000n;
// Per-agent cooldown: skip an agent for this many seconds after topping it up.
// With TOPUP_MICRO=700_000 (700 tx) and TRIGGER_MICRO=500_000 (500 tx remaining at trigger),
// an agent can sustain ~70 tx/min without hitting the wall. The cooldown only gates the
// refill frequency, not the burst window.
const TOPUP_COOLDOWN_S = 600; // 10 minutes

function getTreasuryAccount(): algosdk.Account | null {
  const mnemonic = process.env.ALGO_TREASURY_MNEMONIC;
  if (!mnemonic) return null;
  return algosdk.mnemonicToSecretKey(mnemonic);
}

async function checkAndTopUp(): Promise<void> {
  // CRIT-2: Bail immediately if the system is halted — do not move treasury
  // funds during an active incident (drain, key compromise, admin halt).
  const halt = await isHalted();
  if (halt) {
    console.warn(`[GasStation] System halted (${halt.reason}) — skipping cycle`);
    return;
  }

  const treasury = getTreasuryAccount();
  if (!treasury) {
    console.warn("[GasStation] ALGO_TREASURY_MNEMONIC not set — skipping cycle");
    return;
  }

  // MED-2: Verify treasury has enough balance before starting the top-up loop.
  // Avoids flooding Algod error logs with failed send attempts when the
  // treasury is running low; guardian's TREASURY_LOW_ALERT_ALGO fires separately.
  const algod = getAlgodClient();
  const treasuryInfo    = await algod.accountInformation(treasury.addr.toString()).do();
  const treasuryBalance = BigInt(treasuryInfo.amount ?? 0n);
  if (treasuryBalance < TREASURY_MIN_MICRO) {
    console.warn(
      `[GasStation] Treasury balance ${treasuryBalance} µALGO below minimum ` +
      `${TREASURY_MIN_MICRO} µALGO — skipping cycle`,
    );
    return;
  }

  const redis = getRedis();
  let topped  = 0;

  // MED-1: Use cursor-based SCAN (single O(N) pass) instead of calling
  // listAgents(limit, offset) in a loop — the old approach issued a full
  // redis.keys() scan on every page call, blocking Redis for all other ops.
  const allAgents = await scanAllAgents();
  const active    = allAgents.filter(
    (a) => a.status === "active" || a.status === "registered",
  );

  for (const agent of active) {
    try {
      // HIGH-2: Per-agent cooldown — skip if this agent was topped up recently.
      // Prevents rapid depletion through many small transactions from triggering
      // an unbounded top-up loop against the treasury.
      if (redis) {
        const recentTopUp = await redis.get(`x402:gas:topup:last:${agent.agentId}`);
        if (recentTopUp) continue;
      }

      const info    = await algod.accountInformation(agent.address).do();
      const balance = BigInt(info.amount ?? 0n);
      if (balance >= TRIGGER_MICRO) continue;

      // CRIT-1: Route every top-up through the treasury outflow guard.
      // This records ALGO spend against the daily cap and halts signing if
      // breached — gas station spend was previously invisible to the cap.
      const outflow = await checkAndRecordOutflow(TOPUP_MICRO, 0n);
      if (!outflow.allowed) {
        console.error(
          `[GasStation] Treasury outflow cap reached — stopping cycle. ` +
          `Today: ${outflow.todayAlgo} µALGO / cap: ${outflow.capAlgo} µALGO`,
        );
        return;
      }

      const params   = await getSuggestedParams();
      const topUpTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender:          treasury.addr.toString(),
        receiver:        agent.address,
        amount:          TOPUP_MICRO,
        suggestedParams: params,
        note:            new Uint8Array(Buffer.from(`x402:gas:topup:${agent.agentId}`)),
      });

      try {
        const { txid } = await algod.sendRawTransaction(topUpTxn.signTxn(treasury.sk)).do();
        console.log(
          `[GasStation] Topped up ${agent.agentId} — balance was ${balance} µALGO, ` +
          `sent ${TOPUP_MICRO} µALGO (txid: ${txid})`,
        );
        // HIGH-2: Record cooldown so this agent is skipped for the next 10 min.
        if (redis) {
          await redis.set(`x402:gas:topup:last:${agent.agentId}`, "1", { ex: TOPUP_COOLDOWN_S });
        }
        topped++;
      } catch (sendErr) {
        // Rollback the outflow reservation so the daily cap accurately reflects
        // settled (not attempted) volume.
        await rollbackOutflow(outflow.reservationKey);
        throw sendErr;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[GasStation] Failed to check/top-up ${agent.agentId}: ${msg}`);
    }
  }

  if (topped > 0) {
    console.log(`[GasStation] Cycle complete — ${topped}/${active.length} agents topped up`);
  }
}

/** @internal Exported for unit testing only — do not call from production code. */
export { checkAndTopUp as _checkAndTopUpForTest };

let _intervalId: ReturnType<typeof setInterval> | null = null;

export function startGasStation(): void {
  if (!ENABLED) {
    console.log("[GasStation] Disabled via GAS_STATION_ENABLED=false");
    return;
  }
  if (!process.env.ALGO_TREASURY_MNEMONIC) {
    console.warn("[GasStation] ALGO_TREASURY_MNEMONIC not set — gas top-ups inactive");
    return;
  }

  console.log(
    `[GasStation] Starting — interval ${INTERVAL_MS / 1_000}s, ` +
    `trigger < ${TRIGGER_MICRO} µALGO, top-up ${TOPUP_MICRO} µALGO`,
  );

  checkAndTopUp().catch((err) => console.error("[GasStation] Initial check failed:", err));
  _intervalId = setInterval(() => {
    checkAndTopUp().catch((err) => console.error("[GasStation] Cycle error:", err));
  }, INTERVAL_MS);
}

export function stopGasStation(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}
