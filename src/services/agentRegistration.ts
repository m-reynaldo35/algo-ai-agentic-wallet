import algosdk from "algosdk";
import { getAlgodClient, getSuggestedParams } from "../network/nodely.js";
import {
  storeAgent,
  getAgent,
  assignCohort,
  validateAgentId,
  type AgentRecord,
} from "./agentRegistry.js";
import { checkAndRecordOutflow, rollbackOutflow } from "../protection/treasuryOutflowGuard.js";
import { getAlgoPriceUsdc, registrationFundMicro } from "./algoPrice.js";
import { getRedis } from "./redis.js";
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
 * Treasury-sponsored registration: generates a keypair and atomically funds
 * the wallet, opts it into USDC, and rekeys it to Rocca — all in one group.
 *
 * Uses fee pooling: treasury pays all three transaction fees in Txn 0 so the
 * agent wallet pays zero fees and needs zero pre-existing balance.
 *
 * Treasury cost per registration: ~253,000 µALGO (0.253 ALGO).
 *   200,000 µALGO — MBR after opt-in (base 0.1 + USDC 0.1)
 *    50,000 µALGO — gas buffer (~50 future payment fees)
 *     3,000 µALGO — three transaction fees (fee pooled on Txn 0)
 *
 * Requires ALGO_TREASURY_MNEMONIC to be set. Throws if not configured.
 */
export async function registerNewAgentWithTreasury(
  agentId: string,
  platform?: string,
): Promise<{ mnemonic: string } & RegistrationResult> {
  validateAgentId(agentId);

  const existing = await getAgent(agentId);
  if (existing) throw new Error(`Agent already registered: ${agentId}`);

  const mnemonic_ = process.env.ALGO_TREASURY_MNEMONIC;
  if (!mnemonic_) throw new Error("ALGO_TREASURY_MNEMONIC not set — cannot sponsor registration");

  const treasuryAccount = algosdk.mnemonicToSecretKey(mnemonic_);
  const signerAccount   = getSignerAccount();
  const signerAddress   = signerAccount.addr.toString();
  const agentAccount    = algosdk.generateAccount();
  const agentAddress    = agentAccount.addr.toString();
  const agentMnemonic   = algosdk.secretKeyToMnemonic(agentAccount.sk);
  const cohort          = assignCohort(agentId);

  // ── Anti-Sybil: global daily registration cap ────────────────────────────
  const dailyCap = parseInt(process.env.SPONSORED_DAILY_CAP ?? "50", 10);
  const redis    = getRedis();
  if (redis) {
    const today  = new Date().toISOString().slice(0, 10);
    const capKey = `x402:create:daily:${today}`;
    const count  = await redis.incr(capKey) as number;
    if (count === 1) await redis.expire(capKey, 86_400);
    if (count > dailyCap) {
      throw new Error(`Daily sponsored registration cap reached (${dailyCap}/day). Try again tomorrow.`);
    }
  }

  // ── Oracle-scaled fund amount ─────────────────────────────────────────────
  // Fetch price first so it's available for both the outflow guard and the txn.
  // Throws if CoinGecko has never been reachable (cold start + oracle down) —
  // we refuse to sponsor without a real price to avoid runaway USD spend.
  const priceUsd   = await getAlgoPriceUsdc();
  const FUND_MICRO = registrationFundMicro(priceUsd);
  console.log(
    `[AgentRegistration] Treasury-sponsored registration: ${agentId} — ` +
    `ALGO/USD $${priceUsd.toFixed(4)}, sending ${FUND_MICRO} µALGO`,
  );
  console.log(`[AgentRegistration]   Address: ${agentAddress}  Cohort: ${cohort}`);

  // ── Anti-Sybil: treasury outflow guard ───────────────────────────────────
  // Actual send amount (FUND_MICRO) + fees (3,000) counted against daily cap.
  const outflow = await checkAndRecordOutflow(FUND_MICRO + 3_000n, 0n);
  if (!outflow.allowed) {
    throw new Error(
      `Treasury daily ALGO cap reached — sponsored registration paused. ` +
      `Today: ${outflow.todayAlgo} µALGO / cap: ${outflow.capAlgo} µALGO`,
    );
  }

  const algod  = getAlgodClient();
  const base   = await getSuggestedParams();

  const MIN_FEE = 1_000n;
  const zeroFee    = { ...base, fee: 0n, flatFee: true } as typeof base;
  const pooledFee  = { ...base, fee: 3n * MIN_FEE, flatFee: true } as typeof base;

  // Txn 0: Treasury → Agent (fund + pay all fees)
  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          treasuryAccount.addr.toString(),
    receiver:        agentAddress,
    amount:          FUND_MICRO,
    suggestedParams: pooledFee,
    note:            new Uint8Array(Buffer.from(`x402:agent:fund:${agentId}`)),
  });

  // Txn 1: Agent USDC opt-in (fee pooled = 0)
  const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender:          agentAddress,
    receiver:        agentAddress,
    amount:          0n,
    assetIndex:      USDC_ASA_ID,
    suggestedParams: zeroFee,
    note:            new Uint8Array(Buffer.from(`x402:agent:optin:${agentId}`)),
  });

  // Txn 2: Agent rekey to Rocca signer (fee pooled = 0)
  const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          agentAddress,
    receiver:        agentAddress,
    amount:          0n,
    suggestedParams: zeroFee,
    rekeyTo:         signerAccount.addr,
    note:            new Uint8Array(Buffer.from(`x402:agent:rekey:${agentId}`)),
  });

  algosdk.assignGroupID([fundTxn, optInTxn, rekeyTxn]);

  const signed = [
    fundTxn.signTxn(treasuryAccount.sk),
    optInTxn.signTxn(agentAccount.sk),
    rekeyTxn.signTxn(agentAccount.sk),
  ];

  let txid: string;
  try {
    ({ txid } = await algod.sendRawTransaction(signed).do());
    console.log(`[AgentRegistration] Submitted sponsored group: ${txid}`);
    await algosdk.waitForConfirmation(algod, txid, 4);
    console.log(`[AgentRegistration] Confirmed: ${txid}`);
  } catch (sendErr) {
    // Roll back the outflow reservation so the daily cap isn't consumed
    // by a failed transaction.
    await rollbackOutflow(outflow.reservationKey);
    throw sendErr;
  }

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
    mnemonic:          agentMnemonic,
    cohort,
    authAddr:          signerAddress,
    registrationTxnId: txid,
    explorerUrl:       `https://allo.info/tx/${txid}`,
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
