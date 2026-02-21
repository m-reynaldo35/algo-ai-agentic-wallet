import algosdk from "algosdk";
import { getAlgodClient, getSuggestedParams } from "../network/nodely.js";
import {
  storeAgent,
  getAgent,
  assignCohort,
  validateAgentId,
  type AgentRecord,
} from "./agentRegistry.js";

/**
 * Agent Registration — On-Chain Setup
 *
 * Performs a 3-transaction atomic group to register an AI agent:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  Txn 0 — Fund  (Rocca signer → agent, 0.5 ALGO)                │
 *   │           Signed by: Rocca signer key                          │
 *   │           Covers: min balance (0.1) + USDC opt-in (0.1)        │
 *   │                   + fee buffer (0.3)                            │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │  Txn 1 — USDC Opt-In  (agent → agent, 0 USDC, ASA 31566704)   │
 *   │           Signed by: agent ephemeral key                       │
 *   │           Enables agent to hold and send USDC for x402 tolls   │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │  Txn 2 — Rekey  (agent → self, rekeyTo = Rocca signer)         │
 *   │           Signed by: agent ephemeral key                       │
 *   │           Sets auth-addr = Rocca signer on-chain               │
 *   │           After this, agent private key is discarded forever    │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * After confirmation:
 *   - Agent has a permanent on-chain identity (their address)
 *   - Only the Rocca signer key can authorise transactions from this address
 *   - Agent private key is never stored — discarded immediately after signing
 */

// 0.5 ALGO: covers min balance (0.1) + USDC opt-in reserve (0.1) + fee buffer (0.3)
const AGENT_FUNDING_MICROALGO = 500_000n;

const USDC_ASSET_ID = BigInt(process.env.X402_USDC_ASSET_ID || "31566704");

export interface RegistrationResult {
  agentId: string;
  /** The agent's permanent Algorand address */
  address: string;
  /** Cohort assignment (e.g. "A") */
  cohort: string;
  /** The Rocca signer address set as auth-addr on-chain */
  authAddr: string;
  /** txnId of the confirmed registration atomic group */
  registrationTxnId: string;
  /** Algo explorer link for the registration transaction */
  explorerUrl: string;
}

function getSignerAccount(): algosdk.Account {
  const mnemonic = process.env.ALGO_SIGNER_MNEMONIC;
  if (!mnemonic) throw new Error("ALGO_SIGNER_MNEMONIC not configured");
  return algosdk.mnemonicToSecretKey(mnemonic);
}

/**
 * Register a new AI agent on Algorand.
 *
 * Generates an ephemeral keypair, submits a fund+optin+rekey atomic group,
 * waits for confirmation, stores the record in Redis, then discards the
 * agent's private key. Only the Rocca signer can sign for this agent hereafter.
 *
 * @param agentId  - Unique identifier for this agent (caller-supplied)
 * @param platform - Optional platform tag for grouping (e.g. "openai", "claude")
 */
export async function registerAgent(
  agentId: string,
  platform?: string,
): Promise<RegistrationResult> {

  // ── Pre-flight checks ─────────────────────────────────────────
  validateAgentId(agentId);

  const existing = await getAgent(agentId);
  if (existing) {
    throw new Error(`Agent already registered: ${agentId}`);
  }

  const signerAccount  = getSignerAccount();
  const signerAddress  = signerAccount.addr.toString();
  const cohort         = assignCohort(agentId);

  // ── Generate ephemeral agent keypair ──────────────────────────
  // The private key is used only to sign the opt-in and rekey transactions.
  // It is never stored, never returned, never persisted.
  const agentAccount  = algosdk.generateAccount();
  const agentAddress  = agentAccount.addr.toString();

  console.log(`[AgentRegistration] Registering agent: ${agentId}`);
  console.log(`[AgentRegistration]   Address:  ${agentAddress}`);
  console.log(`[AgentRegistration]   Cohort:   ${cohort}`);
  console.log(`[AgentRegistration]   AuthAddr: ${signerAddress}`);

  const algod  = getAlgodClient();
  const params = await getSuggestedParams();

  // ── Txn 0: Fund ───────────────────────────────────────────────
  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          signerAddress,
    receiver:        agentAddress,
    amount:          AGENT_FUNDING_MICROALGO,
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from(`x402:agent:fund:${agentId}`)),
  });

  // ── Txn 1: USDC Opt-In ────────────────────────────────────────
  const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:          agentAddress,
    receiver:        agentAddress,
    amount:          0n,
    assetIndex:      USDC_ASSET_ID,
    suggestedParams: params,
    note:            new Uint8Array(Buffer.from(`x402:agent:usdc-optin:${agentId}`)),
  });

  // ── Txn 2: Rekey ──────────────────────────────────────────────
  const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          agentAddress,
    receiver:        agentAddress,
    amount:          0n,
    suggestedParams: params,
    rekeyTo:         signerAccount.addr,
    note:            new Uint8Array(Buffer.from(`x402:agent:rekey:${agentId}`)),
  });

  // ── Atomic Group ──────────────────────────────────────────────
  algosdk.assignGroupID([fundTxn, optInTxn, rekeyTxn]);

  // ── Sign ──────────────────────────────────────────────────────
  // Rocca signer signs the funding txn (it's the sender).
  // Agent ephemeral key signs the opt-in and rekey (it's the sender).
  const signedFund   = fundTxn.signTxn(signerAccount.sk);
  const signedOptIn  = optInTxn.signTxn(agentAccount.sk);
  const signedRekey  = rekeyTxn.signTxn(agentAccount.sk);

  // ── Concatenate for broadcast ─────────────────────────────────
  const totalLen = signedFund.length + signedOptIn.length + signedRekey.length;
  const concat   = new Uint8Array(totalLen);
  concat.set(signedFund,   0);
  concat.set(signedOptIn,  signedFund.length);
  concat.set(signedRekey,  signedFund.length + signedOptIn.length);

  // ── Broadcast ─────────────────────────────────────────────────
  console.log(`[AgentRegistration] Broadcasting fund+optin+rekey group...`);
  const { txid } = await algod.sendRawTransaction(concat).do();
  console.log(`[AgentRegistration] Submitted: ${txid}`);

  // ── Confirm ───────────────────────────────────────────────────
  await algosdk.waitForConfirmation(algod, txid, 4);
  console.log(`[AgentRegistration] Confirmed: ${txid}`);

  // ── Persist ───────────────────────────────────────────────────
  // Agent private key (agentAccount.sk) goes out of scope here — never stored.
  const record: AgentRecord = {
    agentId,
    address:             agentAddress,
    cohort,
    authAddr:            signerAddress,
    platform,
    createdAt:           new Date().toISOString(),
    registrationTxnId:  txid,
    status:              "registered",
  };

  await storeAgent(record);
  console.log(`[AgentRegistration] Stored in registry: ${agentId}`);

  return {
    agentId,
    address:             agentAddress,
    cohort,
    authAddr:            signerAddress,
    registrationTxnId:  txid,
    explorerUrl:         `https://allo.info/tx/${txid}`,
  };
}
