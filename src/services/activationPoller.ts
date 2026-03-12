/**
 * Activation Poller — ALGO-Triggered Agent Activation
 *
 * Polls Algorand algod every 10s for ALGO deposits on pending agent addresses.
 * When a pending agent receives ≥ 500 000 µALGO, activates it by:
 *   1. USDC opt-in  (signed with stored agent secret key)
 *   2. Rekey to Rocca signer (signed with stored agent secret key)
 * Both transactions are submitted as an atomic group.
 *
 * The stored secret key is deleted from Redis immediately after activation.
 *
 * Environment variables:
 *   ALGO_SIGNER_MNEMONIC   25-word mnemonic of the Rocca signer (required)
 */

import algosdk from "algosdk";
import { getAlgodClient, getSuggestedParams } from "../network/nodely.js";
import {
  scanAllPendingAgents,
  deletePendingAgent,
  storeAgent,
  assignCohort,
  isHalted,
  type AgentRecord,
} from "./agentRegistry.js";
import { config } from "../config.js";

const ACTIVATION_THRESHOLD_MICRO = 500_000n; // 0.5 ALGO
const INTERVAL_MS                = 10_000;   // 10 seconds
const USDC_ASA_ID                = BigInt(config.x402.usdcAssetId);

function getSignerAccount(): algosdk.Account {
  const mnemonic = process.env.ALGO_SIGNER_MNEMONIC;
  if (!mnemonic) throw new Error("ALGO_SIGNER_MNEMONIC not configured");
  return algosdk.mnemonicToSecretKey(mnemonic);
}

async function checkAndActivate(): Promise<void> {
  const halt = await isHalted();
  if (halt) {
    console.warn(`[ActivationPoller] System halted (${halt.reason}) — skipping cycle`);
    return;
  }

  const pendingAgents = await scanAllPendingAgents();
  if (pendingAgents.length === 0) return;

  const algod         = getAlgodClient();
  const signerAccount = getSignerAccount();
  const signerAddress = signerAccount.addr.toString();

  for (const pending of pendingAgents) {
    try {
      const info    = await algod.accountInformation(pending.address).do();
      const balance = BigInt(info.amount ?? 0n);
      if (balance < ACTIVATION_THRESHOLD_MICRO) continue;

      console.log(
        `[ActivationPoller] ALGO deposit detected for ${pending.agentId} ` +
        `(${balance} µALGO) — activating`,
      );

      const secretKey  = new Uint8Array(Buffer.from(pending.secretKeyB64, "base64"));
      const isOptedIn  = (info.assets ?? []).some(
        (a: { assetId: bigint }) => a.assetId === USDC_ASA_ID,
      );
      const params     = await getSuggestedParams();
      let txid: string;

      if (isOptedIn) {
        // Already opted in — single rekey txn
        const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender:          pending.address,
          receiver:        pending.address,
          amount:          0n,
          suggestedParams: params,
          rekeyTo:         signerAccount.addr,
          note:            new Uint8Array(Buffer.from(`x402:agent:rekey:${pending.agentId}`)),
        });
        ({ txid } = await algod.sendRawTransaction(rekeyTxn.signTxn(secretKey)).do());
      } else {
        // Atomic group: USDC opt-in + rekey
        const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender:          pending.address,
          receiver:        pending.address,
          amount:          0n,
          assetIndex:      USDC_ASA_ID,
          suggestedParams: params,
          note:            new Uint8Array(Buffer.from(`x402:agent:optin:${pending.agentId}`)),
        });
        const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender:          pending.address,
          receiver:        pending.address,
          amount:          0n,
          suggestedParams: params,
          rekeyTo:         signerAccount.addr,
          note:            new Uint8Array(Buffer.from(`x402:agent:rekey:${pending.agentId}`)),
        });
        algosdk.assignGroupID([optInTxn, rekeyTxn]);
        const signed = [optInTxn.signTxn(secretKey), rekeyTxn.signTxn(secretKey)];
        ({ txid } = await algod.sendRawTransaction(signed).do());
      }

      console.log(`[ActivationPoller] Submitted: ${txid}`);
      await algosdk.waitForConfirmation(algod, txid, 4);
      console.log(`[ActivationPoller] Confirmed: ${txid}`);

      const cohort  = assignCohort(pending.agentId);
      const record: AgentRecord = {
        agentId:           pending.agentId,
        address:           pending.address,
        cohort,
        authAddr:          signerAddress,
        custody:           "rocca",
        platform:          pending.platform,
        createdAt:         pending.createdAt,
        registrationTxnId: txid,
        status:            "registered",
      };

      await storeAgent(record);
      await deletePendingAgent(pending.agentId);
      console.log(`[ActivationPoller] Agent ${pending.agentId} activated and stored in registry`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ActivationPoller] Failed to activate ${pending.agentId}: ${msg}`);
    }
  }
}

let _intervalId: ReturnType<typeof setInterval> | null = null;

export function startActivationPoller(): void {
  if (!process.env.ALGO_SIGNER_MNEMONIC) {
    console.warn("[ActivationPoller] ALGO_SIGNER_MNEMONIC not set — activation poller inactive");
    return;
  }

  console.log(
    `[ActivationPoller] Starting — interval 10s, ` +
    `threshold ${ACTIVATION_THRESHOLD_MICRO} µALGO`,
  );

  checkAndActivate().catch((err) =>
    console.error("[ActivationPoller] Initial check failed:", err),
  );

  _intervalId = setInterval(() => {
    checkAndActivate().catch((err) =>
      console.error("[ActivationPoller] Cycle error:", err),
    );
  }, INTERVAL_MS);
}

export function stopActivationPoller(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}
