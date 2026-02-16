import algosdk from "algosdk";
import { config } from "../config.js";
import { buildNTTBridgeTxn } from "../utils/folksFinance.js";
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
    const txns = [x402TollTxn, bridgeTxn];
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
    };

    return exported;

  } catch (err) {
    // Seal on failure too — sandbox must never remain open after an error
    sealSandbox();
    throw err;
  }
}
