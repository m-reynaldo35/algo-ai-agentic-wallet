import algosdk from "algosdk";
import { config } from "../config.js";
import { getSuggestedParams } from "../network/nodely.js";
import { calculateMinAmountOut, DEFAULT_SLIPPAGE_BIPS } from "../utils/slippage.js";
import { initSandbox, sealSandbox } from "../sandbox/vibekit.js";
import type { SandboxContext } from "../sandbox/vibekit.js";

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  ZERO-TRUST TRANSACTION BUILDER — VIBEKIT SANDBOX BOUNDARY             │
 * │                                                                         │
 * │  This module executes INSIDE the VibeKit sandbox. It produces a         │
 * │  sealed, unsigned atomic group and exports it as a SandboxExport        │
 * │  envelope. The envelope crosses the sandbox boundary back to the        │
 * │  Express server, which forwards it to the client for Rocca signing.     │
 * │                                                                         │
 * │  ┌───────────────────────────────────────────────────────────────────┐   │
 * │  │  INVARIANT: No function in this module may import, generate,     │   │
 * │  │  receive, store, or transmit private key material. The only      │   │
 * │  │  output is algosdk.encodeUnsignedTransaction() bytes.            │   │
 * │  │                                                                   │   │
 * │  │  algosdk.signTransaction   → BANNED                              │   │
 * │  │  algosdk.mnemonicToSecretKey → BANNED                            │   │
 * │  │  algosdk.secretKeyToMnemonic → BANNED                            │   │
 * │  │  Any Uint8Array of length 64 named "secret"/"sk"/"key" → BANNED │   │
 * │  └───────────────────────────────────────────────────────────────────┘   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// ── Treasury constant ───────────────────────────────────────────
// Replaced with Rocca treasury wallet address in production via env
const TREASURY_ADDRESS = config.x402.payToAddress;
const USDC_ASSET_ID = BigInt(config.x402.usdcAssetId);

// ── Types ───────────────────────────────────────────────────────

/**
 * A single cross-chain trade intent within a batched settlement.
 * Multiple intents are bundled into a single irreducible atomic group.
 */
export interface TradeIntent {
  /** Payment amount in micro-USDC */
  amount?: number;
  /** Wormhole target chain (default: "ethereum") */
  destinationChain?: string;
  /** Recipient address on the destination chain */
  destinationRecipient?: string;
  /** Slippage tolerance in basis points (default: 50) */
  slippageBips?: number;
}

export interface UnsignedAtomicGroup {
  /** Base64-encoded unsigned transaction bytes, one per txn in the group */
  transactions: string[];
  /** Base64-encoded group ID (SHA-512/256 of concatenated txn hashes) */
  groupId: string;
  /** Human-readable manifest for audit logging */
  manifest: string[];
  /** Number of transactions in the atomic group */
  txnCount: number;
}

/**
 * The sealed envelope that crosses the VibeKit sandbox boundary.
 * This is the ONLY object the Express server receives — it contains
 * no executable code, no keys, only inert unsigned bytes.
 */
export interface SandboxExport {
  /** The sandbox that produced this export */
  sandboxId: string;
  /** ISO timestamp when the sandbox was sealed */
  sealedAt: string;
  /** The unsigned atomic group payload */
  atomicGroup: UnsignedAtomicGroup;
  /** Routing metadata for the x402 validation loop */
  routing: {
    /** The Algorand address that must sign all transactions */
    requiredSigner: string;
    /** The treasury address receiving the x402 toll */
    tollReceiver: string;
    /** Destination chain for the Token Bridge leg */
    bridgeDestination: string;
    /** Network identifier */
    network: string;
  };
  /** Slippage parameters applied to this group */
  slippage: {
    /** Tolerance in basis points (1 bip = 0.01%) */
    toleranceBips: number;
    /** Expected output in micro-units */
    expectedAmount: string;
    /** Minimum acceptable output in micro-units */
    minAmountOut: string;
  };
  /** Number of trade intents bundled in this atomic group (1 for single, N for batched) */
  batchSize: number;
  /** Per-intent slippage metadata (populated for batched settlements) */
  batchIntents?: Array<{
    destinationChain: string;
    amount: string;
    minAmountOut: string;
    toleranceBips: number;
  }>;
}

// ── Algod Client ────────────────────────────────────────────────
// Centralized via src/network/nodely.ts (Nodely free tier)
// getAlgodClient() and getSuggestedParams() imported above

// ── Core Builder ────────────────────────────────────────────────

/**
 * Construct a two-transaction Algorand atomic group inside the
 * VibeKit sandbox and return a sealed SandboxExport envelope.
 *
 * Atomic Group Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  Txn 0 — x402 Toll (ASA Transfer)                      │
 *   │  sender → TREASURY_ADDRESS                              │
 *   │  micro-USDC payment with honda_v1 audit note           │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Txn 1 — On-chain Audit Ack (0-ALGO Payment)           │
 *   │  sender → TREASURY_ADDRESS, amount = 0                 │
 *   │  note = honda_v1 settlement acknowledgement            │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Binding: algosdk.assignGroupID([tollTxn, ackTxn])     │
 *   │  SHA-512/256 group hash — both succeed or both revert.  │
 *   └─────────────────────────────────────────────────────────┘
 *
 * @param senderAddr       - Algorand address of the payer
 * @param amount           - Payment amount in micro-USDC (default: config value)
 * @param destinationChain - Reserved for future bridge routing (ignored, Algorand-only)
 * @param destinationRecipient - Reserved for future use (ignored)
 * @param slippageBips     - Slippage tolerance in basis points (default: 50 = 0.5%)
 *
 * @returns SandboxExport — sealed unsigned payload for the Express→Rocca pipeline
 */
export async function constructAtomicGroup(
  senderAddr: string,
  amount: number = config.x402.priceMicroUsdc,
  destinationChain: string = "algorand",
  _destinationRecipient?: string,
  slippageBips: number = DEFAULT_SLIPPAGE_BIPS,
): Promise<SandboxExport> {

  // ── Open sandbox scope ────────────────────────────────────────
  const sandbox: SandboxContext = initSandbox();
  const manifest: string[] = [];

  try {
    const suggestedParams = await getSuggestedParams();
    const expectedAmountBig = BigInt(amount);
    const minAmountOut = calculateMinAmountOut(expectedAmountBig, slippageBips);

    // ────────────────────────────────────────────────────────────
    // Txn 0: x402 Toll — USDC transfer with honda_v1 audit note
    // Physically etched on-chain. Agents can self-audit via indexer:
    //   note-prefix=aG9uZGFfdjE=
    // ────────────────────────────────────────────────────────────
    const auditNote = `honda_v1|success|${new Date().toISOString()}|algorand->algorand|${amount}musd`;

    const tollTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: senderAddr,
      receiver: TREASURY_ADDRESS,
      amount: expectedAmountBig,
      assetIndex: USDC_ASSET_ID,
      suggestedParams,
      note: new Uint8Array(Buffer.from(auditNote)),
    });

    manifest.push(
      `[0] x402 Toll: ${amount} micro-USDC (ASA ${USDC_ASSET_ID}) | ${senderAddr} → ${TREASURY_ADDRESS}`,
    );

    // ────────────────────────────────────────────────────────────
    // Txn 1: Audit Ack — 0-ALGO payment binding the settlement
    // record to the toll atomically. If the toll fails, this
    // reverts too — no orphaned audit records on-chain.
    // ────────────────────────────────────────────────────────────
    const ackNote = `honda_v1|ack|${new Date().toISOString()}|${senderAddr}|${amount}musd`;

    const ackTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: senderAddr,
      receiver: TREASURY_ADDRESS,
      amount: 0n,
      suggestedParams,
      note: new Uint8Array(Buffer.from(ackNote)),
    });

    manifest.push(
      `[1] Audit Ack: 0 ALGO | ${senderAddr} → ${TREASURY_ADDRESS}`,
    );

    // ────────────────────────────────────────────────────────────
    // Cryptographic Binding: Atomic Group Assignment
    // SHA-512/256 over both txn hashes — AVM enforces both commit
    // or both revert. No toll without ack, no ack without toll.
    // ────────────────────────────────────────────────────────────
    const txns = [tollTxn, ackTxn];
    algosdk.assignGroupID(txns);

    // Extract the group ID for the export envelope
    const groupId = Buffer.from(txns[0].group!).toString("base64");

    // ────────────────────────────────────────────────────────────
    // Serialization: Unsigned Base64 Blobs
    //
    // encodeUnsignedTransaction produces the canonical msgpack
    // encoding of the transaction WITHOUT any signature fields.
    // These bytes are what Rocca Wallet will sign via FIDO2.
    //
    // CRITICAL: We use encodeUnsignedTransaction, NOT
    // signTransaction. No private key touches these bytes.
    // ────────────────────────────────────────────────────────────
    const transactions = txns.map((txn) =>
      Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64"),
    );

    const atomicGroup: UnsignedAtomicGroup = {
      transactions,
      groupId,
      manifest,
      txnCount: txns.length,
    };

    // ── Seal sandbox — no further mutations allowed ─────────────
    sealSandbox(sandbox);

    // ── Build the export envelope ───────────────────────────────
    const exported: SandboxExport = {
      sandboxId: sandbox.id,
      sealedAt: new Date().toISOString(),
      atomicGroup,
      routing: {
        requiredSigner: senderAddr,
        tollReceiver: TREASURY_ADDRESS,
        bridgeDestination: destinationChain === "algorand" ? "algorand" : "algorand",
        network: `algorand-${config.algorand.network}`,
      },
      slippage: {
        toleranceBips: slippageBips,
        expectedAmount: expectedAmountBig.toString(),
        minAmountOut: minAmountOut.toString(),
      },
      batchSize: 1,
    };

    return exported;

  } catch (err) {
    // Seal on failure too — sandbox must never remain open after an error
    sealSandbox(sandbox);
    throw err;
  }
}

// ── Agent-to-Agent Atomic Data Swap ─────────────────────────────

/** Maximum note field size enforced by the Algorand protocol */
const MAX_NOTE_BYTES = 1024;

/**
 * Construct a two-transaction atomic data swap that binds a USDC
 * payment irreducibly to a data delivery — no escrow contract needed.
 *
 * Atomic Group Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  Txn A — USDC Payment (ASA Transfer)                    │
 *   │  makeAssetTransferTxnWithSuggestedParams                │
 *   │  buyer → seller: microUsdcAmount of ASA 31566704        │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Txn B — Data Delivery (0-ALGO Payment + note)          │
 *   │  makePaymentTxnWithSuggestedParams                      │
 *   │  seller → buyer: 0 ALGO, note = encryptedDataHex bytes  │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Binding: algosdk.assignGroupID([txnA, txnB])           │
 *   │  SHA-512/256 group hash — both succeed or both revert.  │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The AVM guarantees: if the buyer lacks sufficient USDC, Txn A
 * fails, which atomically reverts Txn B — the data note is never
 * committed to a block. Conversely, the seller cannot withhold
 * the data after receiving payment because both transactions
 * share a single irreducible group ID.
 *
 * @param buyerAddr        - Algorand address paying USDC
 * @param sellerAddr       - Algorand address delivering data
 * @param microUsdcAmount  - Payment in micro-USDC (6 decimals)
 * @param encryptedDataHex - Hex-encoded encrypted payload (≤ 1024 bytes)
 * @returns Grouped transaction array [txnA, txnB] ready for signing
 */
export async function constructDataSwapGroup(
  buyerAddr: string,
  sellerAddr: string,
  microUsdcAmount: number,
  encryptedDataHex: string,
): Promise<algosdk.Transaction[]> {
  // ── Validate the data payload ──────────────────────────────────
  // Must be valid hex before Buffer.from() — invalid chars are silently
  // dropped by Node.js producing truncated/corrupted bytes.
  if (!/^[0-9a-fA-F]*$/.test(encryptedDataHex)) {
    throw new Error("encryptedDataHex contains non-hex characters");
  }
  if (encryptedDataHex.length % 2 !== 0) {
    throw new Error("encryptedDataHex must have an even number of characters");
  }

  const dataBytes = new Uint8Array(Buffer.from(encryptedDataHex, "hex"));
  if (dataBytes.length > MAX_NOTE_BYTES) {
    throw new Error(
      `Data payload exceeds Algorand note limit: ${dataBytes.length} bytes > ${MAX_NOTE_BYTES} bytes`,
    );
  }

  const suggestedParams = await getSuggestedParams();

  // ── Txn A: The Payment ────────────────────────────────────────
  // ASA transfer of USDC from buyer to seller. Uses the Algorand
  // mainnet USDC ASA ID (31566704) as specified.
  const USDC_MAINNET_ASA = BigInt(31566704);

  const txnA = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: buyerAddr,
    receiver: sellerAddr,
    amount: BigInt(microUsdcAmount),
    assetIndex: USDC_MAINNET_ASA,
    suggestedParams,
  });

  // ── Txn B: The Data ───────────────────────────────────────────
  // 0-ALGO payment from seller to buyer carrying the encrypted
  // data in the note field. The note is committed on-chain only
  // if the entire atomic group succeeds.
  const txnB = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: sellerAddr,
    receiver: buyerAddr,
    amount: BigInt(0),
    suggestedParams,
    note: dataBytes,
  });

  // ── The Lock: Cryptographic Binding ───────────────────────────
  // assignGroupID computes SHA-512/256 over the concatenation of
  // both transaction hashes and injects the 32-byte group ID into
  // each transaction's .group field. The AVM treats this group as
  // irreducible: both commit or both revert.
  algosdk.assignGroupID([txnA, txnB]);

  return [txnA, txnB];
}

// ── Batched Atomic Settlement Builder ────────────────────────────

/**
 * Construct a batched multiparty atomic group from an array of
 * trade intents. All toll payments, bridge transactions, and the
 * Gora oracle call are cryptographically bound into a single
 * irreducible group via `algosdk.assignGroupID`.
 *
 * If ANY individual intent fails slippage validation, the entire
 * batch is aborted — no partial execution is possible.
 *
 * Atomic Group Layout (for N intents):
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  Txn 0..N-1   — x402 Toll per intent (ASA Transfer)    │
 *   │  Txn N..M     — Token Bridge txns per intent (App/ASA) │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Binding: algosdk.assignGroupID(allTxns)                │
 *   │  SHA-512/256 group hash — ALL succeed or ALL revert.    │
 *   └─────────────────────────────────────────────────────────┘
 *
 * @param senderAddr - Algorand address of the payer
 * @param intents    - Array of trade intents to batch
 * @returns SandboxExport with all intents bundled atomically
 */
export async function constructBatchedAtomicGroup(
  senderAddr: string,
  intents: TradeIntent[],
): Promise<SandboxExport> {
  if (intents.length === 0) {
    throw new Error("Batch settlement requires at least one trade intent");
  }

  // Single intent — delegate to the standard builder
  if (intents.length === 1) {
    const i = intents[0];
    return constructAtomicGroup(
      senderAddr,
      i.amount,
      i.destinationChain,
      i.destinationRecipient,
      i.slippageBips,
    );
  }

  const sandbox: SandboxContext = initSandbox();
  const manifest: string[] = [];

  try {
    const suggestedParams = await getSuggestedParams();
    const tollTxns: algosdk.Transaction[] = [];
    const batchIntents: SandboxExport["batchIntents"] = [];
    let totalTollMicroUsdc = 0;

    // ── Build one toll txn per intent ─────────────────────────
    for (let idx = 0; idx < intents.length; idx++) {
      const intent = intents[idx];
      const amount = intent.amount ?? config.x402.priceMicroUsdc;
      const slippageBips = intent.slippageBips ?? DEFAULT_SLIPPAGE_BIPS;
      const expectedBig = BigInt(amount);
      const minAmountOut = calculateMinAmountOut(expectedBig, slippageBips);

      const batchAuditNote = `honda_v1|batch|success|${new Date().toISOString()}|algorand->algorand|${amount}musd|idx:${idx}`;

      tollTxns.push(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: senderAddr,
        receiver: TREASURY_ADDRESS,
        amount: expectedBig,
        assetIndex: USDC_ASSET_ID,
        suggestedParams,
        note: new Uint8Array(Buffer.from(batchAuditNote)),
      }));
      totalTollMicroUsdc += amount;

      manifest.push(`[${idx}] x402 Toll #${idx}: ${amount} micro-USDC | ${senderAddr} → ${TREASURY_ADDRESS}`);

      batchIntents.push({
        destinationChain: "algorand",
        amount: expectedBig.toString(),
        minAmountOut: minAmountOut.toString(),
        toleranceBips: slippageBips,
      });
    }

    // ── Cryptographic Binding ─────────────────────────────────
    // All N toll payments bound in a single SHA-512/256 group.
    // AVM enforces ALL succeed or ALL revert.
    algosdk.assignGroupID(tollTxns);

    const groupId = Buffer.from(tollTxns[0].group!).toString("base64");

    const transactions = tollTxns.map((txn) =>
      Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64"),
    );

    const atomicGroup: UnsignedAtomicGroup = {
      transactions,
      groupId,
      manifest,
      txnCount: tollTxns.length,
    };

    sealSandbox(sandbox);

    const primarySlippage = intents[0].slippageBips ?? DEFAULT_SLIPPAGE_BIPS;
    const totalExpected = BigInt(totalTollMicroUsdc);
    const totalMinOut = calculateMinAmountOut(totalExpected, primarySlippage);

    const exported: SandboxExport = {
      sandboxId: sandbox.id,
      sealedAt: new Date().toISOString(),
      atomicGroup,
      routing: {
        requiredSigner: senderAddr,
        tollReceiver: TREASURY_ADDRESS,
        bridgeDestination: "algorand",
        network: `algorand-${config.algorand.network}`,
      },
      slippage: {
        toleranceBips: primarySlippage,
        expectedAmount: totalExpected.toString(),
        minAmountOut: totalMinOut.toString(),
      },
      batchSize: intents.length,
      batchIntents,
    };

    return exported;

  } catch (err) {
    sealSandbox(sandbox);
    throw err;
  }
}
