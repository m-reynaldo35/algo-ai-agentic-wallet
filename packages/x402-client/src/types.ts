// ── Configuration ──────────────────────────────────────────────

export interface ClientConfig {
  /** Base URL of the x402 server (e.g., "https://api.example.com") */
  baseUrl: string;
  /** Ed25519 private key (64-byte Algorand secret key) */
  privateKey: Uint8Array;
  /** Slippage tolerance in basis points. Default: 50 (0.5%). Max: 500 */
  slippageBips?: number;
  /** Max retry attempts for transient network failures. Default: 2 */
  maxRetries?: number;
  /** Progress callback fired at each pipeline stage */
  onProgress?: ProgressCallback;
}

// ── Cross-chain Destinations ───────────────────────────────────

export const DestinationChain = {
  ETHEREUM: "ethereum",
  SOLANA: "solana",
  BASE: "base",
  ALGORAND: "algorand",
} as const;

export type DestinationChain = (typeof DestinationChain)[keyof typeof DestinationChain];

// ── Trade Parameters ───────────────────────────────────────────

export interface TradeParams {
  /** Your Algorand sender address (58-char Base32) */
  senderAddress: string;
  /** Micro-USDC amount. Omit to use the server's default toll */
  amount?: number;
  /** Destination chain for USDC bridging. Default: "ethereum" */
  destinationChain?: DestinationChain | string;
  /** Recipient address on the destination chain */
  destinationRecipient?: string;
}

export interface BatchTradeIntent {
  amount?: number;
  destinationChain?: DestinationChain | string;
  destinationRecipient?: string;
  slippageBips?: number;
}

export interface BatchTradeParams {
  /** Your Algorand sender address */
  senderAddress: string;
  /** Array of individual trade intents (max 16 — Algorand atomic group limit) */
  intents: BatchTradeIntent[];
}

// ── Progress Callbacks ─────────────────────────────────────────

export type PipelineStage =
  | "handshake"
  | "proof_built"
  | "sandbox_ready"
  | "settling"
  | "confirmed"
  | "failed";

export interface ProgressEvent {
  stage: PipelineStage;
  message: string;
  data?: Record<string, unknown>;
}

export type ProgressCallback = (event: ProgressEvent) => void;

// ── Error Codes ────────────────────────────────────────────────

export enum X402ErrorCode {
  /** Configuration problem (bad baseUrl, invalid key, etc.) */
  CONFIG_ERROR = "CONFIG_ERROR",
  /** Server returned 402 but the offer expired before proof was built */
  OFFER_EXPIRED = "OFFER_EXPIRED",
  /** Unsupported x402 protocol version from server */
  UNSUPPORTED_VERSION = "UNSUPPORTED_VERSION",
  /** Failed to fetch Algorand suggested params (network issue) */
  NETWORK_ERROR = "NETWORK_ERROR",
  /** The /api/agent-action call failed */
  SANDBOX_ERROR = "SANDBOX_ERROR",
  /** The /api/execute pipeline failed */
  SETTLEMENT_ERROR = "SETTLEMENT_ERROR",
  /** Batch size exceeded Algorand atomic group limit (16) */
  BATCH_SIZE_EXCEEDED = "BATCH_SIZE_EXCEEDED",
  /** TEAL LogicSig policy breach — agent exceeded spending bounds */
  POLICY_BREACH = "POLICY_BREACH",
  /** Unknown / unclassified error */
  UNKNOWN = "UNKNOWN",
}

// ── x402 Pay+JSON (402 Response) ───────────────────────────────

export interface PayJson {
  version: "x402-v1";
  status: 402;
  network: {
    protocol: "algorand";
    chain: string;
  };
  payment: {
    asset: {
      type: "ASA";
      id: number;
      symbol: string;
      decimals: number;
    };
    amount: string;
    payTo: string;
  };
  expires: string;
  memo: string;
  error?: string;
}

// ── X-PAYMENT Proof ────────────────────────────────────────────

export interface X402PaymentProof {
  groupId: string;
  transactions: string[];
  senderAddr: string;
  signature: string;
  /** Unix epoch seconds — enforced within 60s time bound */
  timestamp?: number;
  /** Number Used Once — prevents signature replay */
  nonce?: string;
}

// ── Sandbox Export (returned by /api/agent-action) ─────────────

export interface SandboxExport {
  sandboxId: string;
  sealedAt: string;
  atomicGroup: {
    transactions: string[];
    groupId: string;
    manifest: string[];
    txnCount: number;
  };
  routing: {
    requiredSigner: string;
    tollReceiver: string;
    bridgeDestination: string;
    network: string;
  };
  slippage: {
    toleranceBips: number;
    expectedAmount: string;
    minAmountOut: string;
  };
  batchSize?: number;
  batchIntents?: Array<{
    destinationChain: string;
    expectedAmount: string;
    minAmountOut: string;
  }>;
}

export interface AgentActionResponse {
  status: "awaiting_signature";
  export: SandboxExport;
  instructions: string[];
}

export interface BatchActionResponse {
  status: "awaiting_signature";
  export: SandboxExport;
  batchSize: number;
  instructions: string[];
}

// ── Settlement Result (returned by /api/execute) ───────────────

export interface SettlementResult {
  success: true;
  agentId: string;
  sandboxId: string;
  settlement: {
    confirmed: boolean;
    confirmedRound: number;
    txnId: string;
    groupId: string;
    txnCount: number;
    settledAt: string;
  };
}

export interface SettlementFailure {
  success?: false;
  error: string;
  failedStage?: "validation" | "auth" | "sign" | "broadcast";
  detail?: string;
}

// ── Unified Trade Result ───────────────────────────────────────

export type TradeResult = SettlementResult | SettlementFailure;
