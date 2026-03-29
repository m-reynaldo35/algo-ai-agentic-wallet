/**
 * Activation Poller — Mandate Contract USDC Detection
 *
 * Polls every 10s for USDC balance on MandateContract app accounts.
 * When a registered agent's contract account holds any USDC, the agent
 * is marked active — payment capability is confirmed.
 *
 * No server-side signing. No USDC opt-in. No Rocca rekey.
 * The MandateContract handles USDC opt-in via `opt_in_usdc()`.
 * The agent holds their own key; the AVM enforces all mandate gates.
 *
 * Activation flow:
 *   1. Agent is registered via POST /api/agents/register-mandate
 *      (status = "active", but contract may not yet be funded)
 *   2. Operator deploys MandateContract via MandateFactory.create_agent()
 *   3. Agent funds the contract app account with ALGO (gas) + USDC (spending)
 *   4. This poller detects USDC > 0 → confirms agent is ready to pay
 *
 * For pending agents (registered without mandateAppId — CLI pre-factory path):
 *   - Pending records expire via Redis TTL (24h); no activation attempted.
 */

import algosdk from "algosdk";
import { getAlgodClient } from "../network/nodely.js";
import {
  scanAllPendingAgents,
  deletePendingAgent,
  scanAllAgents,
  updateAgentRecord,
  isHalted,
} from "./agentRegistry.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

const USDC_ASA_ID = BigInt(config.x402.usdcAssetId);
const INTERVAL_MS = 10_000; // 10 seconds

// ── Mandate contract USDC check ───────────────────────────────────

/**
 * Check all registered agents that have a mandateAppId.
 * When the contract's app account has USDC > 0 the agent is confirmed funded.
 * Log the status — no state change needed here since register-mandate sets
 * status = "active" immediately. This is a health / confirmation pass.
 */
async function checkMandateContracts(): Promise<void> {
  const halt = await isHalted();
  if (halt) {
    logger.warn({ reason: halt.reason }, "[ActivationPoller] System halted — skipping cycle");
    return;
  }

  const agents = await scanAllAgents();
  const mandateAgents = agents.filter((a) => a.mandateAppId && a.mandateAppId > 0);
  if (mandateAgents.length === 0) return;

  const algod = getAlgodClient();

  for (const agent of mandateAgents) {
    try {
      const appAddress = algosdk.getApplicationAddress(BigInt(agent.mandateAppId!)).toString();
      const info = await algod.accountInformation(appAddress).do();

      const usdcBalance = ((info.assets ?? []) as Array<{ assetId: bigint; amount: bigint }>)
        .find((a) => a.assetId === USDC_ASA_ID)?.amount ?? 0n;

      const algoBalance = BigInt(info.amount ?? 0n);

      if (usdcBalance > 0n && agent.status !== "active") {
        // Contract is funded — ensure agent is marked active
        await updateAgentRecord({ ...agent, status: "active" });
        logger.info(
          { agentId: agent.agentId, appId: agent.mandateAppId, usdcBalance: usdcBalance.toString() },
          "[ActivationPoller] Mandate contract funded — agent marked active",
        );
      }

      // Advisory log when contract exists but has no USDC yet
      if (usdcBalance === 0n && algoBalance > 0n) {
        logger.debug(
          { agentId: agent.agentId, appId: agent.mandateAppId, algoBalance: algoBalance.toString() },
          "[ActivationPoller] Contract has ALGO but no USDC yet — awaiting deposit",
        );
      }
    } catch (err) {
      // Non-fatal — app may not exist on-chain yet (factory not deployed, or testnet vs mainnet)
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(
        { agentId: agent.agentId, appId: agent.mandateAppId, err: msg },
        "[ActivationPoller] Could not check contract — skipping",
      );
    }
  }
}

/**
 * Expire pending agents that have no mandateAppId and no activity.
 * These are orphaned pre-factory registrations. Redis TTL handles expiry,
 * but we log them so the operator can monitor the queue.
 */
async function logPendingAgents(): Promise<void> {
  const pending = await scanAllPendingAgents();
  if (pending.length > 0) {
    logger.debug(
      { count: pending.length },
      "[ActivationPoller] Pending agents awaiting manual mandate deployment",
    );
  }
}

// ── Poller lifecycle ──────────────────────────────────────────────

let _intervalId: ReturnType<typeof setInterval> | null = null;

export function startActivationPoller(): void {
  logger.info("[ActivationPoller] Starting — mandate contract USDC detection, interval 10s");

  const cycle = (): void => {
    checkMandateContracts().catch((err) =>
      logger.error({ err }, "[ActivationPoller] Cycle error"),
    );
    logPendingAgents().catch(() => {/* non-fatal */});
  };

  cycle(); // immediate first run
  _intervalId = setInterval(cycle, INTERVAL_MS);
}

export function stopActivationPoller(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info("[ActivationPoller] Stopped");
  }
}
