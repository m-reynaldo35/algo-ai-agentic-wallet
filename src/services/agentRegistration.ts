import algosdk from "algosdk";
import { getAlgodClient, getSuggestedParams } from "../network/nodely.js";
import {
  storeAgent,
  getAgent,
  assignCohort,
  validateAgentId,
  type AgentRecord,
} from "./agentRegistry.js";
import { config } from "../config.js";

const USDC_ASA_ID = BigInt(config.x402.usdcAssetId);

/**
 * Minimum ALGO a fresh wallet must hold before registration can proceed:
 *   0.10 ALGO — base minimum balance
 *   0.10 ALGO — USDC ASA minimum balance (added on opt-in)
 *   0.001     — opt-in transaction fee
 *   0.001     — rekey transaction fee
 *   0.003     — gas buffer (≈ 3 future payment fees)
 */
export const MINIMUM_FUNDING_MICRO = 205_000n;

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

export interface GeneratedKeypair {
  agentId: string;
  address: string;
  /** 25-word mnemonic — show once, the server never persists it */
  mnemonic: string;
  /** Minimum µALGO the user must send to this address before calling register-existing */
  minimumFundingMicro: bigint;
}

function getSignerAccount(): algosdk.Account {
  const mnemonic = process.env.ALGO_SIGNER_MNEMONIC;
  if (!mnemonic) throw new Error("ALGO_SIGNER_MNEMONIC not configured");
  return algosdk.mnemonicToSecretKey(mnemonic);
}

/**
 * Generate a fresh Algorand keypair for a new agent.
 *
 * This is a pure in-process operation — no network calls, no blockchain
 * transactions, no treasury cost. The caller (wizard UI) stores the mnemonic
 * in browser state, shows it to the user once, and later calls
 * registerExistingAgent() once the user has funded the wallet.
 *
 * The server never persists the mnemonic.
 */
export function generateAgentKeypair(agentId: string): GeneratedKeypair {
  validateAgentId(agentId);
  const account = algosdk.generateAccount();
  return {
    agentId,
    address:            account.addr.toString(),
    mnemonic:           algosdk.secretKeyToMnemonic(account.sk),
    minimumFundingMicro: MINIMUM_FUNDING_MICRO,
  };
}

/**
 * Register an existing funded wallet as an agent by rekeying it to Rocca.
 *
 * The caller supplies the mnemonic of a wallet that already holds at least
 * MINIMUM_FUNDING_MICRO µALGO. This function handles the USDC opt-in and
 * rekey in one atomic group if the wallet is not yet opted in, or just the
 * rekey if it already is. The user pays all on-chain fees from their own
 * wallet — no treasury funds are used.
 *
 * @param agentId  - Unique identifier for this agent
 * @param mnemonic - 25-word mnemonic of the wallet to register
 * @param platform - Optional platform tag
 */
export async function registerExistingAgent(
  agentId: string,
  mnemonic: string,
  platform?: string,
): Promise<RegistrationResult> {
  validateAgentId(agentId);

  const existing = await getAgent(agentId);
  if (existing) throw new Error(`Agent already registered: ${agentId}`);

  const signerAccount = getSignerAccount();
  const signerAddress = signerAccount.addr.toString();
  const agentAccount  = algosdk.mnemonicToSecretKey(mnemonic);
  const agentAddress  = agentAccount.addr.toString();
  const cohort        = assignCohort(agentId);

  console.log(`[AgentRegistration] Registering agent: ${agentId}`);
  console.log(`[AgentRegistration]   Address:  ${agentAddress}`);
  console.log(`[AgentRegistration]   Cohort:   ${cohort}`);
  console.log(`[AgentRegistration]   AuthAddr: ${signerAddress}`);

  const algod  = getAlgodClient();
  const params = await getSuggestedParams();

  // Check whether the wallet has already opted into USDC
  const accountInfo = await algod.accountInformation(agentAddress).do();
  const isOptedIn   = (accountInfo.assets ?? []).some(
    (a: { assetId: bigint }) => a.assetId === USDC_ASA_ID,
  );

  let txid: string;

  if (isOptedIn) {
    // Wallet already has USDC opt-in — single rekey txn
    console.log(`[AgentRegistration] USDC already opted in — single rekey`);
    const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender:          agentAddress,
      receiver:        agentAddress,
      amount:          0n,
      suggestedParams: params,
      rekeyTo:         signerAccount.addr,
      note:            new Uint8Array(Buffer.from(`x402:agent:rekey:${agentId}`)),
    });
    ({ txid } = await algod.sendRawTransaction(rekeyTxn.signTxn(agentAccount.sk)).do());
  } else {
    // Atomic group: USDC opt-in + rekey — user pays both fees from their own wallet
    console.log(`[AgentRegistration] USDC not opted in — atomic opt-in + rekey`);
    const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender:          agentAddress,
      receiver:        agentAddress,
      amount:          0n,
      assetIndex:      USDC_ASA_ID,
      suggestedParams: params,
      note:            new Uint8Array(Buffer.from(`x402:agent:optin:${agentId}`)),
    });
    const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender:          agentAddress,
      receiver:        agentAddress,
      amount:          0n,
      suggestedParams: params,
      rekeyTo:         signerAccount.addr,
      note:            new Uint8Array(Buffer.from(`x402:agent:rekey:${agentId}`)),
    });
    algosdk.assignGroupID([optInTxn, rekeyTxn]);
    const signed = [optInTxn.signTxn(agentAccount.sk), rekeyTxn.signTxn(agentAccount.sk)];
    ({ txid } = await algod.sendRawTransaction(signed).do());
  }

  console.log(`[AgentRegistration] Submitted: ${txid}`);
  await algosdk.waitForConfirmation(algod, txid, 4);
  console.log(`[AgentRegistration] Confirmed: ${txid}`);

  const record: AgentRecord = {
    agentId,
    address:           agentAddress,
    cohort,
    authAddr:          signerAddress,
    custody:           "rocca",
    platform,
    createdAt:         new Date().toISOString(),
    registrationTxnId: txid,
    status:            "registered",
  };

  await storeAgent(record);
  console.log(`[AgentRegistration] Stored in registry: ${agentId}`);

  return {
    agentId,
    address:           agentAddress,
    cohort,
    authAddr:          signerAddress,
    registrationTxnId: txid,
    explorerUrl:       `https://allo.info/tx/${txid}`,
  };
}
