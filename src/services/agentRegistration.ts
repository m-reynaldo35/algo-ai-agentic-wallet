import algosdk from "algosdk";
import { getAlgodClient, getSuggestedParams } from "../network/nodely.js";
import {
  storeAgent,
  getAgent,
  assignCohort,
  validateAgentId,
  type AgentRecord,
} from "./agentRegistry.js";

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
 * Register an existing funded wallet as an agent by rekeying it to Rocca.
 *
 * The caller supplies the mnemonic of an already-funded, USDC-opted-in
 * wallet. A single rekey transaction sets auth-addr = Rocca signer on-chain.
 * The caller retains their private key for signing x402 payment proofs.
 *
 * @param agentId  - Unique identifier for this agent
 * @param mnemonic - 25-word mnemonic of the wallet to rekey
 * @param platform - Optional platform tag
 */
export async function registerExistingAgent(
  agentId: string,
  mnemonic: string,
  platform?: string,
): Promise<RegistrationResult> {

  validateAgentId(agentId);

  const existing = await getAgent(agentId);
  if (existing) {
    throw new Error(`Agent already registered: ${agentId}`);
  }

  const signerAccount = getSignerAccount();
  const signerAddress = signerAccount.addr.toString();
  const agentAccount  = algosdk.mnemonicToSecretKey(mnemonic);
  const agentAddress  = agentAccount.addr.toString();
  const cohort        = assignCohort(agentId);

  console.log(`[AgentRegistration] Rekeying existing wallet as agent: ${agentId}`);
  console.log(`[AgentRegistration]   Address:  ${agentAddress}`);
  console.log(`[AgentRegistration]   Cohort:   ${cohort}`);
  console.log(`[AgentRegistration]   AuthAddr: ${signerAddress}`);

  const algod  = getAlgodClient();
  const params = await getSuggestedParams();

  // Single rekey txn — the agent's wallet already has ALGO and USDC opt-in
  const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          agentAddress,
    receiver:        agentAddress,
    amount:          0n,
    suggestedParams: params,
    rekeyTo:         signerAccount.addr,
    note:            new Uint8Array(Buffer.from(`x402:agent:rekey:${agentId}`)),
  });

  const signedRekey = rekeyTxn.signTxn(agentAccount.sk);

  console.log(`[AgentRegistration] Broadcasting rekey...`);
  const { txid } = await algod.sendRawTransaction(signedRekey).do();
  console.log(`[AgentRegistration] Submitted: ${txid}`);

  await algosdk.waitForConfirmation(algod, txid, 4);
  console.log(`[AgentRegistration] Confirmed: ${txid}`);

  const record: AgentRecord = {
    agentId,
    address:            agentAddress,
    cohort,
    authAddr:           signerAddress,
    platform,
    createdAt:          new Date().toISOString(),
    registrationTxnId: txid,
    status:             "registered",
  };

  await storeAgent(record);
  console.log(`[AgentRegistration] Stored in registry: ${agentId}`);

  return {
    agentId,
    address:            agentAddress,
    cohort,
    authAddr:           signerAddress,
    registrationTxnId: txid,
    explorerUrl:        `https://allo.info/tx/${txid}`,
  };
}

