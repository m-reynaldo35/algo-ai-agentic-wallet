// ── Configuration ──────────────────────────────────────────────

export interface ClientConfig {
  /** Base URL of the x402 server (e.g., "https://api.example.com") */
  baseUrl: string;
  /** Ed25519 private key (64-byte Algorand secret key) */
  privateKey: Uint8Array;
  /** Slippage tolerance in basis points. Default: 50 (0.5%). Max: 500 */
  slippageBips?: number;
}

// ── Trade Parameters ───────────────────────────────────────────

export interface TradeParams {
  /** Your Algorand sender address (58-char Base32) */
  senderAddress: string;
  /** Micro-USDC amount. Omit to use the server's default toll */
  amount?: number;
  /** Wormhole destination chain (default: "ethereum") */
  destinationChain?: string;
  /** Recipient address on the destination chain */
  destinationRecipient?: string;
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
}

export interface AgentActionResponse {
  status: "awaiting_signature";
  export: SandboxExport;
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
  error: string;
  failedStage: "validation" | "auth" | "sign" | "broadcast";
  detail: string;
}

// ── Unified Trade Result ───────────────────────────────────────

export type TradeResult = SettlementResult | SettlementFailure;
