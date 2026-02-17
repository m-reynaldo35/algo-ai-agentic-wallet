import algosdk from "algosdk";
import { config } from "../config.js";
import { buildNTTBridgeTxn } from "../utils/folksFinance.js";
import { buildGoraOracleAppCall, buildGoraFeeTxn } from "../utils/gora.js";
import { calculateMinAmountOut, DEFAULT_SLIPPAGE_BIPS } from "../utils/slippage.js";
import { initSandbox, sealSandbox, type SandboxContext } from "../sandbox/vibekit.js";

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
    /** Destination chain for the NTT bridge leg */
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

function getAlgodClient(): algosdk.Algodv2 {
  return new algosdk.Algodv2(
    config.algorand.nodeToken,
    config.algorand.nodeUrl,
  );
}

/**
 * Fetch suggested params from the Algorand node.
 * In sandbox/test environments where the node is unreachable,
 * falls back to deterministic mock params that match the
 * algosdk.SuggestedParams shape exactly.
 */
async function getSuggestedParams(): Promise<algosdk.SuggestedParams> {
  try {
    const client = getAlgodClient();
    return await client.getTransactionParams().do();
  } catch {
    // Sandbox fallback: deterministic params for offline construction.
    // These produce valid unsigned transaction structures that can be
    // re-parameterized by Rocca before signing if needed.
    return {
      flatFee: true,
      fee: BigInt(1000),
      minFee: BigInt(1000),
      firstValid: BigInt(1000),
      lastValid: BigInt(2000),
      genesisID: `${config.algorand.network}-v1.0`,
      genesisHash: new Uint8Array(32), // 32-byte zero hash for sandbox
    };
  }
}

// ── Core Builder ────────────────────────────────────────────────

/**
 * Construct a two-transaction Algorand atomic group inside the
 * VibeKit sandbox and return a sealed SandboxExport envelope.
 *
 * Atomic Group Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  Txn 0 — x402 Toll (ASA Transfer)                      │
 *   │  makeAssetTransferTxnWithSuggestedParams                │
 *   │  sender → TREASURY_ADDRESS                              │
 *   │  0.10 USDC (100,000 micro-USDC, ASA ID from config)    │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Txn 1 — Folks Finance NTT Bridge (Application Call)   │
 *   │  makeApplicationNoOpTxn → Folks NTT App                 │
 *   │  Routes USDC cross-chain via Wormhole NTT               │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Binding: algosdk.assignGroupID([txn0, txn1])           │
 *   │  Both txns share a single SHA-512/256 group hash.       │
 *   │  If either fails on-chain, both revert atomically.      │
 *   └─────────────────────────────────────────────────────────┘
 *
 * @param senderAddr       - Algorand address of the payer (will sign via Rocca)
 * @param amount           - Payment amount in micro-USDC (default: 100,000 = $0.10)
 * @param destinationChain - Wormhole target chain (default: "ethereum")
 * @param destinationRecipient - Optional recipient on destination chain
 * @param slippageBips     - Slippage tolerance in basis points (default: 50 = 0.5%)
 *
 * @returns SandboxExport — sealed unsigned payload for the Express→Rocca pipeline
 */
export async function constructAtomicGroup(
  senderAddr: string,
  amount: number = config.x402.priceMicroUsdc,
  destinationChain: string = "ethereum",
  destinationRecipient?: string,
  slippageBips: number = DEFAULT_SLIPPAGE_BIPS,
): Promise<SandboxExport> {

  // ── Open sandbox scope ────────────────────────────────────────
  const sandbox: SandboxContext = initSandbox();
  const manifest: string[] = [];

  try {
    const suggestedParams = await getSuggestedParams();

    // ────────────────────────────────────────────────────────────
    // Txn 0: The x402 Toll
    //
    // ASA Transfer of exactly 0.10 USDC from the requesting agent's
    // address to the protocol treasury. This is the monetization
    // layer — every agent-action call costs one toll.
    // ────────────────────────────────────────────────────────────
    const x402TollTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: senderAddr,
      receiver: TREASURY_ADDRESS,
      amount: BigInt(amount),
      assetIndex: USDC_ASSET_ID,
      suggestedParams,
      note: new Uint8Array(Buffer.from(
        JSON.stringify({
          protocol: "x402",
          type: "toll",
          amount,
          asset: `ASA:${USDC_ASSET_ID}`,
          ts: Date.now(),
        }),
      )),
    });

    manifest.push(
      `[0] x402 Toll: ${amount} micro-USDC (ASA ${USDC_ASSET_ID}) | ${senderAddr} → ${TREASURY_ADDRESS}`,
    );

    // ────────────────────────────────────────────────────────────
    // Slippage Guardrail: Deterministic Minimum Output
    //
    // Compute the minimum acceptable output using strict bigint
    // arithmetic. This value is encoded into the NTT bridge
    // transaction's ABI arguments, enforced on-chain.
    // ────────────────────────────────────────────────────────────
    const expectedAmountBig = BigInt(amount);
    const minAmountOut = calculateMinAmountOut(expectedAmountBig, slippageBips);

    // ────────────────────────────────────────────────────────────
    // Txn 1: The Folks Finance NTT Bridge
    //
    // Application NoOp call to the Folks Finance NTT contract.
    // Routes USDC cross-chain via Wormhole Native Token Transfer.
    // The app call encodes: method selector, amount, destination
    // chain ID, recipient address, dedup nonce, and minAmountOut.
    // ────────────────────────────────────────────────────────────
    const bridgeTxn = await buildNTTBridgeTxn(
      {
        sender: senderAddr,
        amount,
        destinationChain,
        destinationRecipient,
        minAmountOut,
      },
      suggestedParams,
    );

    manifest.push(
      `[1] NTT Bridge: ${amount} micro-USDC via Wormhole | algorand → ${destinationChain}${destinationRecipient ? ` → ${destinationRecipient}` : ""} | slippage: ${slippageBips}bips, minOut: ${minAmountOut}`,
    );

    // ────────────────────────────────────────────────────────────
    // Txn 2: Gora Oracle Request Fee
    //
    // Payment transaction to the Gora Oracle application address
    // covering the oracle request fee. This ensures the oracle
    // price feed query is funded within the same atomic group.
    // ────────────────────────────────────────────────────────────
    const goraFeeTxn = buildGoraFeeTxn(senderAddr, suggestedParams);

    manifest.push(
      `[2] Gora Oracle Fee: ${config.gora.requestFeeMicroAlgo} microAlgo | ${senderAddr} → Gora App (${config.gora.appId})`,
    );

    // ────────────────────────────────────────────────────────────
    // Txn 3: Gora Oracle Price Feed Request
    //
    // Application NoOp call to the Gora Oracle contract requesting
    // the latest USDC/ALGO price assertion. The oracle data is
    // used by the validation loop (Module 2) to independently
    // verify the cross-chain swap rate before signing proceeds.
    // ────────────────────────────────────────────────────────────
    const goraOracleCallTxn = await buildGoraOracleAppCall(
      { sender: senderAddr, feedKey: config.gora.priceFeedKey },
      suggestedParams,
    );

    manifest.push(
      `[3] Gora Oracle: Request ${config.gora.priceFeedKey} price feed | App ID: ${config.gora.appId}`,
    );

    // ────────────────────────────────────────────────────────────
    // Cryptographic Binding: Atomic Group Assignment
    //
    // algosdk.assignGroupID computes SHA-512/256 over the
    // concatenation of all transaction hashes, then injects the
    // resulting 32-byte group ID into each transaction's .group
    // field. On-chain, the Algorand AVM enforces that ALL
    // transactions sharing a group ID must appear together in the
    // same block and ALL must succeed — or ALL revert.
    //
    // This guarantees: no toll without bridge, no bridge without toll.
    // ────────────────────────────────────────────────────────────
    const txns = [x402TollTxn, bridgeTxn, goraFeeTxn, goraOracleCallTxn];
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
    sealSandbox();

    // ── Build the export envelope ───────────────────────────────
    const exported: SandboxExport = {
      sandboxId: sandbox.id,
      sealedAt: new Date().toISOString(),
      atomicGroup,
      routing: {
        requiredSigner: senderAddr,
        tollReceiver: TREASURY_ADDRESS,
        bridgeDestination: destinationChain,
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
    sealSandbox();
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
  // ── Validate the data payload fits the note field ─────────────
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
 *   │  Txn N..2N-1  — NTT Bridge per intent (App Call)       │
 *   │  Txn 2N       — Gora Oracle Fee (Payment)              │
 *   │  Txn 2N+1     — Gora Oracle Price Request (App Call)   │
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
    const bridgeTxns: algosdk.Transaction[] = [];
    const batchIntents: SandboxExport["batchIntents"] = [];
    let totalTollMicroUsdc = 0;

    // ── Build toll + bridge pairs for each intent ──────────────
    for (let idx = 0; idx < intents.length; idx++) {
      const intent = intents[idx];
      const amount = intent.amount ?? config.x402.priceMicroUsdc;
      const destChain = intent.destinationChain ?? "ethereum";
      const slippageBips = intent.slippageBips ?? DEFAULT_SLIPPAGE_BIPS;

      // Toll transaction for this intent
      const tollTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: senderAddr,
        receiver: TREASURY_ADDRESS,
        amount: BigInt(amount),
        assetIndex: USDC_ASSET_ID,
        suggestedParams,
        note: new Uint8Array(Buffer.from(
          JSON.stringify({
            protocol: "x402",
            type: "toll",
            batch: true,
            index: idx,
            amount,
            asset: `ASA:${USDC_ASSET_ID}`,
            ts: Date.now(),
          }),
        )),
      });
      tollTxns.push(tollTxn);
      totalTollMicroUsdc += amount;

      manifest.push(
        `[${idx * 2}] x402 Toll #${idx}: ${amount} micro-USDC | ${senderAddr} → ${TREASURY_ADDRESS}`,
      );

      // Slippage guardrail for this intent
      const expectedBig = BigInt(amount);
      const minAmountOut = calculateMinAmountOut(expectedBig, slippageBips);

      // Bridge transaction for this intent
      const bridgeTxn = await buildNTTBridgeTxn(
        {
          sender: senderAddr,
          amount,
          destinationChain: destChain,
          destinationRecipient: intent.destinationRecipient,
          minAmountOut,
        },
        suggestedParams,
      );
      bridgeTxns.push(bridgeTxn);

      manifest.push(
        `[${idx * 2 + 1}] NTT Bridge #${idx}: ${amount} micro-USDC → ${destChain} | slippage: ${slippageBips}bips, minOut: ${minAmountOut}`,
      );

      batchIntents.push({
        destinationChain: destChain,
        amount: expectedBig.toString(),
        minAmountOut: minAmountOut.toString(),
        toleranceBips: slippageBips,
      });
    }

    // ── Shared Gora oracle call (one per batch) ─────────────────
    const goraFeeTxn = buildGoraFeeTxn(senderAddr, suggestedParams);
    const oracleIdx = intents.length * 2;
    manifest.push(
      `[${oracleIdx}] Gora Oracle Fee: ${config.gora.requestFeeMicroAlgo} microAlgo`,
    );

    const goraOracleCallTxn = await buildGoraOracleAppCall(
      { sender: senderAddr, feedKey: config.gora.priceFeedKey },
      suggestedParams,
    );
    manifest.push(
      `[${oracleIdx + 1}] Gora Oracle: Request ${config.gora.priceFeedKey} price feed`,
    );

    // ── Cryptographic Binding: Single Irreducible Atomic Group ──
    // All toll payments, all bridge calls, and the oracle call are
    // bound by a single SHA-512/256 group hash. The Algorand AVM
    // enforces that ALL must succeed or ALL revert atomically.
    // A failed slippage check on ANY intent kills the ENTIRE batch.
    const allTxns = [...tollTxns, ...bridgeTxns, goraFeeTxn, goraOracleCallTxn];
    algosdk.assignGroupID(allTxns);

    const groupId = Buffer.from(allTxns[0].group!).toString("base64");

    const transactions = allTxns.map((txn) =>
      Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64"),
    );

    const atomicGroup: UnsignedAtomicGroup = {
      transactions,
      groupId,
      manifest,
      txnCount: allTxns.length,
    };

    sealSandbox();

    // Aggregate slippage uses the first intent's tolerance as the envelope value
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
        bridgeDestination: intents.map((i) => i.destinationChain ?? "ethereum").join(","),
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
    sealSandbox();
    throw err;
  }
}
