/**
 * Activation Poller — Mandate Contract USDC Detection
 *
 * Polls every 10s for USDC balance on MandateContract app accounts.
 * When a registered agent's contract account holds any USDC, the agent
 * is marked active — payment capability is confirmed.
 *
 * No server-side signing. No Rocca rekey.
 * The agent (or any caller) calls opt_in_usdc() on the contract directly
 * after funding it with ALGO. The server never pays on the agent's behalf.
 *
 * Activation flow:
 *   1. Operator deploys MandateContract via POST /api/agents/create-mandate
 *   2. User sends ≥0.5 ALGO to the contract app account (MBR + fee reserve)
 *   3. User (or agent) calls opt_in_usdc() on the contract — no auth required
 *   4. User sends USDC to the contract app account
 *   5. This poller detects USDC > 0 → marks agent active
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

      const assets       = (info.assets ?? []) as Array<{ assetId: bigint; amount: bigint }>;
      const usdcEntry    = assets.find((a) => a.assetId === USDC_ASA_ID);
      const usdcOptedIn  = usdcEntry !== undefined;
      const usdcBalance  = usdcEntry?.amount ?? 0n;
      const algoBalance  = BigInt(info.amount ?? 0n);

      // Contract funded with USDC — confirm agent active
      if (usdcBalance > 0n && agent.status !== "active") {
        await updateAgentRecord({ ...agent, status: "active" });
        logger.info(
          { agentId: agent.agentId, appId: agent.mandateAppId, usdcBalance: usdcBalance.toString() },
          "[ActivationPoller] Mandate contract funded — agent marked active",
        );
      }

      // Advisory: contract exists but USDC not yet present
      if (!usdcOptedIn) {
        logger.debug(
          { agentId: agent.agentId, appId: agent.mandateAppId, algoBalance: algoBalance.toString() },
          "[ActivationPoller] Contract awaiting opt_in_usdc() + USDC deposit",
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
