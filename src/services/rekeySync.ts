/**
 * Rekey Sync — Reboot Registry Reconciliation
 *
 * On container restart after an unexpected termination, dangling
 * x402:rekey-in-progress:{agentId} locks may exist in Redis for
 * agents whose rekey transaction either:
 *
 *   A. Succeeded on-chain but the registry write never happened
 *      (process killed between waitForConfirmation and updateAgentRecord)
 *
 *   B. Failed or was never broadcast (process killed before/during broadcast)
 *
 * This module runs once at boot, before the API begins serving requests.
 * It scans all dangling locks, queries the Algorand node for the current
 * on-chain auth-addr of each affected agent, and forces the registry to
 * match the chain state.
 *
 * Principle: "On-Chain State is the Only Truth."
 *
 *   on-chain authAddr === Rocca signer → agent is under Rocca custody
 *                                         (rekey failed or was never submitted)
 *   on-chain authAddr ≠  Rocca signer → agent is under user custody
 *                                         (rekey succeeded on-chain)
 *
 * In both cases the dangling lock is cleared after reconciliation.
 */

import { getRedis }     from "./redis.js";
import { getAlgodClient } from "../network/nodely.js";
import { getAgent, updateAgentRecord } from "./agentRegistry.js";
import { emitSecurityEvent }           from "./securityAudit.js";
import { config }                      from "../config.js";

const REKEY_IN_PROGRESS_PREFIX = "x402:rekey-in-progress:";

/**
 * Scan for dangling rekey-in-progress locks and reconcile each affected
 * agent's registry record against the current on-chain auth-addr.
 *
 * Runs sequentially (one agent at a time) to avoid flooding algod with
 * parallel accountInformation queries at boot.
 *
 * Safe to call multiple times — idempotent (lock existence is the gate).
 */
export async function runRekeySync(): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    console.warn("[RekeySync] Redis unavailable — skipping rekey sync");
    return;
  }

  const roccaSignerAddress = config.rocca.signerAddress;
  if (!roccaSignerAddress) {
    console.warn("[RekeySync] ROCCA_SIGNER_ADDRESS not set — skipping rekey sync");
    return;
  }

  let lockKeys: string[];
  try {
    lockKeys = await redis.keys(`${REKEY_IN_PROGRESS_PREFIX}*`) as string[];
  } catch (err) {
    console.error(
      "[RekeySync] Failed to scan for dangling locks:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (lockKeys.length === 0) {
    console.log("[RekeySync] No dangling rekey locks found — registry is clean");
    return;
  }

  console.warn(
    `[RekeySync] Found ${lockKeys.length} dangling rekey lock(s) — reconciling against on-chain state`,
  );

  for (const lockKey of lockKeys) {
    const agentId = lockKey.replace(REKEY_IN_PROGRESS_PREFIX, "");
    await reconcileAgent(agentId, lockKey, roccaSignerAddress);
  }

  console.log("[RekeySync] Rekey sync complete");
}

async function reconcileAgent(
  agentId:             string,
  lockKey:             string,
  roccaSignerAddress:  string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  console.log(`[RekeySync] Reconciling agent ${agentId}...`);

  const agent = await getAgent(agentId);
  if (!agent) {
    // Agent was deleted from registry — just clear the stale lock
    console.warn(`[RekeySync] Agent ${agentId} not found in registry — clearing stale lock`);
    await redis.del(lockKey);
    return;
  }

  // Query on-chain state
  let onChainAuthAddr: string | null;
  try {
    const accountInfo  = await getAlgodClient().accountInformation(agent.address).do();
    onChainAuthAddr    = accountInfo.authAddr?.toString() ?? null;
  } catch (err) {
    console.error(
      `[RekeySync] Cannot query on-chain state for ${agent.address}:`,
      err instanceof Error ? err.message : err,
    );
    // Don't clear the lock — we can't determine the correct state
    return;
  }

  const previousAuthAddr = agent.authAddr;

  if (onChainAuthAddr === roccaSignerAddress || onChainAuthAddr === null) {
    // Case B: rekey did not complete on-chain (or account is unrekeyed → Rocca custody)
    // Ensure registry reflects Rocca custody and clear the lock.
    if (agent.custody !== "rocca" || agent.authAddr !== roccaSignerAddress) {
      const corrected = {
        ...agent,
        authAddr: roccaSignerAddress,
        custody: "rocca" as const,
      };
      await updateAgentRecord(corrected);

      emitSecurityEvent({
        type:    "REKEY_SYNC_CORRECTION",
        agentId,
        detail: {
          outcome:           "rekey_not_completed",
          previousAuthAddr,
          onChainAuthAddr,
          registryCorrected: true,
          note:              "on-chain auth-addr is Rocca signer — rekey did not reach chain",
        },
        timestamp: new Date().toISOString(),
      });

      console.log(
        `[RekeySync] ${agentId}: rekey not on-chain — registry corrected to Rocca custody`,
      );
    } else {
      console.log(`[RekeySync] ${agentId}: registry already correct (Rocca custody) — clearing stale lock`);
    }

  } else {
    // Case A: rekey completed on-chain but registry was not updated
    // Force registry to match the chain.
    const newCustodyVersion = (agent.custodyVersion ?? 0) + 1;
    const corrected = {
      ...agent,
      authAddr:       onChainAuthAddr,
      custody:        "user" as const,
      custodyVersion: newCustodyVersion,
    };
    await updateAgentRecord(corrected);

    emitSecurityEvent({
      type:    "REKEY_SYNC_CORRECTION",
      agentId,
      detail: {
        outcome:            "rekey_completed_on_chain",
        previousAuthAddr,
        onChainAuthAddr,
        newCustodyVersion,
        registryCorrected:  true,
        note:               "on-chain auth-addr ≠ Rocca signer — registry updated to user custody",
      },
      timestamp: new Date().toISOString(),
    });

    console.log(
      `[RekeySync] ${agentId}: rekey confirmed on-chain — registry updated to user custody ` +
      `(authAddr: ${onChainAuthAddr})`,
    );
  }

  // Always clear the lock after reconciliation
  await redis.del(lockKey);
}
