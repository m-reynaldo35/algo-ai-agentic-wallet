/**
 * MandateFactory — Server-side contract deployment service
 *
 * Calls MandateFactory.create_agent() on Algorand to deploy a new
 * MandateContract instance for an agent. Signed by the operator wallet
 * (OPERATOR_MNEMONIC), which is also set as the contract's master wallet.
 *
 * Also provides callOptInUsdc() — used by the activation poller to opt
 * the deployed contract into USDC once the user has funded it with ALGO.
 *
 * Requires env vars:
 *   OPERATOR_MNEMONIC      — 25-word mnemonic of the operator Algorand account
 *   MANDATE_FACTORY_APP_ID — app ID of the deployed MandateFactory
 */

import algosdk from "algosdk";
import { getAlgodClient } from "../network/nodely.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";

// ── Config ────────────────────────────────────────────────────────────────────

const FACTORY_APP_ID = Number(process.env.MANDATE_FACTORY_APP_ID ?? "0");

// ARC-4 method selectors
const CREATE_AGENT_SELECTOR = Buffer.from(
  algosdk.ABIMethod.fromSignature(
    "create_agent(address,address,uint64,uint64,uint64)uint64",
  ).getSelector(),
);

const OPT_IN_USDC_SELECTOR = Buffer.from(
  algosdk.ABIMethod.fromSignature("opt_in_usdc()void").getSelector(),
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreateAgentResult {
  mandateAppId: number;
  appAddress:   string;
  txid:         string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOperatorAccount(): algosdk.Account {
  const m = process.env.OPERATOR_MNEMONIC;
  if (!m) throw new Error("OPERATOR_MNEMONIC env var is not set");
  return algosdk.mnemonicToSecretKey(m);
}

function encodeUint64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return buf;
}

// ── createMandateAgent ────────────────────────────────────────────────────────

/**
 * Deploy a new MandateContract via MandateFactory.create_agent().
 *
 * The operator wallet signs the factory call and is set as the contract's
 * master wallet, allowing the server to later call opt_in_usdc() and
 * update_mandate() on behalf of portal-created agents.
 *
 * @param agentKey     - Algorand address of the agent (holds its own signing key)
 * @param maxPerTx     - Per-transaction USDC cap in micro-USDC
 * @param velocityCap  - 10-minute rolling USDC cap in micro-USDC
 * @param dailyCap     - 24-hour rolling USDC cap in micro-USDC
 */
export async function createMandateAgent(
  agentKey:    string,
  maxPerTx:    number,
  velocityCap: number,
  dailyCap:    number,
): Promise<CreateAgentResult> {
  if (!FACTORY_APP_ID) {
    throw new Error("MANDATE_FACTORY_APP_ID is not configured — deploy the factory first");
  }

  const algod    = getAlgodClient();
  const operator = getOperatorAccount();
  const sp       = await algod.getTransactionParams().do();

  // ARC-4 encoding: address = 32 raw bytes, uint64 = 8 bytes big-endian
  const agentBytes  = algosdk.decodeAddress(agentKey).publicKey;
  const masterBytes = algosdk.decodeAddress(operator.addr.toString()).publicKey;

  // Fee: outer (1000) + inner app-create (1000) — pooled
  const txn = algosdk.makeApplicationCallTxnFromObject({
    sender:          operator.addr.toString(),
    appIndex:        FACTORY_APP_ID,
    onComplete:      algosdk.OnApplicationComplete.NoOpOC,
    appArgs:         [
      CREATE_AGENT_SELECTOR,
      agentBytes,
      masterBytes,
      encodeUint64(maxPerTx),
      encodeUint64(velocityCap),
      encodeUint64(dailyCap),
    ],
    boxes: [
      { appIndex: FACTORY_APP_ID, name: new Uint8Array(Buffer.from("__approval__")) },
      { appIndex: FACTORY_APP_ID, name: new Uint8Array(Buffer.from("__clear__")) },
    ],
    suggestedParams: { ...sp, fee: 2_000n, flatFee: true },
  });

  const signedBytes = txn.signTxn(operator.sk);
  const submitResult = await algod.sendRawTransaction(signedBytes).do() as { txid: string };
  const txid = submitResult.txid;

  await algosdk.waitForConfirmation(algod, txid, 5);

  // Extract new app ID from inner transaction (factory fires one inner app-create)
  const pending = await algod.pendingTransactionInformation(txid).do() as unknown as Record<string, unknown>;
  const innerTxns = (pending["inner-txns"] as Array<Record<string, unknown>> | undefined) ?? [];
  const mandateAppId = Number((innerTxns[0]?.["application-index"] as number | bigint | undefined) ?? 0);

  if (!mandateAppId) {
    throw new Error(`Factory transaction ${txid} did not produce a new app ID in inner-txns`);
  }

  const appAddress = algosdk.getApplicationAddress(BigInt(mandateAppId)).toString();

  logger.info(
    { agentKey, mandateAppId, appAddress, txid },
    "[MandateFactory] MandateContract deployed",
  );

  return { mandateAppId, appAddress, txid };
}

// ── callOptInUsdc ─────────────────────────────────────────────────────────────

/**
 * Call opt_in_usdc() on a MandateContract app account.
 *
 * Only works when the operator wallet is the contract's master wallet
 * (i.e., the contract was deployed via createMandateAgent()). The
 * activation poller calls this once the contract has been funded with ALGO.
 *
 * @param mandateAppId - Application ID of the target MandateContract
 */
export async function callOptInUsdc(mandateAppId: number): Promise<string> {
  const algod    = getAlgodClient();
  const operator = getOperatorAccount();
  const sp       = await algod.getTransactionParams().do();

  // Fee: outer (1000) + inner ASA opt-in (1000) — pooled
  // Foreign assets must be declared so the AVM can resolve the USDC asset ID
  const txn = algosdk.makeApplicationCallTxnFromObject({
    sender:          operator.addr.toString(),
    appIndex:        mandateAppId,
    onComplete:      algosdk.OnApplicationComplete.NoOpOC,
    appArgs:         [OPT_IN_USDC_SELECTOR],
    foreignAssets:   [config.x402.usdcAssetId],
    suggestedParams: { ...sp, fee: 2_000n, flatFee: true },
  });

  const signedBytes = txn.signTxn(operator.sk);
  const submitResult = await algod.sendRawTransaction(signedBytes).do() as { txid: string };
  const txid = submitResult.txid;

  await algosdk.waitForConfirmation(algod, txid, 5);

  logger.info({ mandateAppId, txid }, "[MandateFactory] opt_in_usdc confirmed");
  return txid;
}
