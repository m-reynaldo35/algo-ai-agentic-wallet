import algosdk from "algosdk";
import { config } from "../config.js";

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Folks Finance — Wormhole Native Token Transfer (NTT)           │
 * │                                                                 │
 * │  Constructs an UNSIGNED Application NoOp call to the Folks      │
 * │  Finance NTT contract on Algorand, routing USDC cross-chain     │
 * │  via Wormhole. All transactions are unsigned — signing is       │
 * │  delegated to Rocca Wallet via FIDO2/Liquid Auth.               │
 * │                                                                 │
 * │  NO PRIVATE KEY MATERIAL MAY EXIST IN THIS MODULE.              │
 * └─────────────────────────────────────────────────────────────────┘
 */

// ── Folks Finance NTT Contract Constants ────────────────────────
// Placeholder App IDs — replace with mainnet/testnet deployments
export const FOLKS_NTT_APP_ID = BigInt(process.env.FOLKS_NTT_APP_ID || "1000000001");
export const WORMHOLE_CORE_APP_ID = BigInt(process.env.WORMHOLE_CORE_APP_ID || "1000000002");
export const WORMHOLE_TOKEN_BRIDGE_APP_ID = BigInt(process.env.WORMHOLE_TOKEN_BRIDGE_APP_ID || "1000000003");

// ── Gora Oracle App ID (re-exported for foreign apps reference) ─
export const GORA_ORACLE_APP_ID = BigInt(process.env.GORA_APP_ID || "1275319623");

// Wormhole chain IDs (standard)
export const WORMHOLE_CHAIN_IDS: Record<string, number> = {
  algorand: 8,
  ethereum: 2,
  solana: 1,
  avalanche: 6,
  polygon: 5,
  base: 30,
  arbitrum: 23,
  optimism: 24,
};

// ABI method selectors for Folks Finance NTT contract
const ABI_METHODS = {
  /** Initiate a cross-chain NTT transfer via Wormhole */
  nttTransfer: new Uint8Array(Buffer.from("6e74745f7472616e73666572", "hex")), // "ntt_transfer"
  /** Query bridge status */
  getTransferStatus: new Uint8Array(Buffer.from("6765745f737461747573", "hex")), // "get_status"
} as const;

export interface NTTBridgeParams {
  sender: string;
  /** Amount in micro-units of the source asset (e.g., micro-USDC) */
  amount: number;
  /** Target chain name (e.g., "ethereum", "solana", "base") */
  destinationChain: string;
  /** Recipient address on the destination chain (hex or native format) */
  destinationRecipient?: string;
  /** Minimum acceptable output after slippage (bigint micro-units). If omitted, no floor is enforced. */
  minAmountOut?: bigint;
}

/**
 * Build an unsigned Application NoOp transaction targeting the
 * Folks Finance NTT contract for a cross-chain USDC transfer.
 *
 * ABI argument layout:
 *   arg[0]: Method selector — "ntt_transfer"
 *   arg[1]: Amount (uint64, big-endian)
 *   arg[2]: Destination Wormhole chain ID (uint16, big-endian)
 *   arg[3]: Destination recipient (32-byte padded address)
 *   arg[4]: Nonce (uint32, for Wormhole message dedup)
 *   arg[5]: MinAmountOut (uint64, big-endian) — slippage floor
 *
 * Foreign assets: USDC ASA
 * Foreign apps:   Wormhole Core, Wormhole Token Bridge
 */
export async function buildNTTBridgeTxn(
  params: NTTBridgeParams,
  suggestedParams: algosdk.SuggestedParams,
): Promise<algosdk.Transaction> {
  const { sender, amount, destinationChain, destinationRecipient, minAmountOut } = params;

  const destChainId = WORMHOLE_CHAIN_IDS[destinationChain];
  if (destChainId === undefined) {
    throw new Error(`Unsupported destination chain: ${destinationChain}. Supported: ${Object.keys(WORMHOLE_CHAIN_IDS).join(", ")}`);
  }

  // ── Encode ABI arguments ──────────────────────────────────────

  // arg[0]: Method selector
  const methodSelector = ABI_METHODS.nttTransfer;

  // arg[1]: Amount as uint64 big-endian
  const amountArg = algosdk.encodeUint64(BigInt(amount));

  // arg[2]: Destination chain ID as uint16 big-endian
  const chainIdArg = new Uint8Array(2);
  new DataView(chainIdArg.buffer).setUint16(0, destChainId, false);

  // arg[3]: Destination recipient — 32-byte zero-padded
  // For EVM chains: strip 0x prefix, left-pad to 32 bytes
  // For non-EVM: use raw bytes, right-pad to 32 bytes
  const recipientArg = new Uint8Array(32);
  if (destinationRecipient) {
    const cleanAddr = destinationRecipient.replace(/^0x/, "");
    const recipientBytes = Buffer.from(cleanAddr, "hex");
    // Left-pad for EVM (20-byte address → 32 bytes)
    recipientArg.set(recipientBytes, 32 - recipientBytes.length);
  }

  // arg[4]: Nonce — unique per transfer for Wormhole message dedup
  const nonceArg = new Uint8Array(4);
  new DataView(nonceArg.buffer).setUint32(0, Math.floor(Math.random() * 0xffffffff), false);

  // arg[5]: MinAmountOut — slippage floor as uint64 big-endian
  // If not provided, defaults to the full amount (zero slippage tolerance)
  const minAmountOutArg = algosdk.encodeUint64(minAmountOut ?? BigInt(amount));

  // ── Construct the Application NoOp call ───────────────────────
  const appCallTxn = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: FOLKS_NTT_APP_ID,
    appArgs: [methodSelector, amountArg, chainIdArg, recipientArg, nonceArg, minAmountOutArg],
    foreignAssets: [BigInt(config.x402.usdcAssetId)],
    foreignApps: [WORMHOLE_CORE_APP_ID, WORMHOLE_TOKEN_BRIDGE_APP_ID, GORA_ORACLE_APP_ID],
    suggestedParams,
    note: new Uint8Array(Buffer.from(`x402:ntt:${destinationChain}:${Date.now()}`)),
  });

  return appCallTxn;
}
