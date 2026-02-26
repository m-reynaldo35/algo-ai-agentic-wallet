/**
 * Mandate Types — AP2 + FIDO2 mandate data model
 *
 * All µUSDC amounts are stored as decimal strings (BigInt serialization)
 * to avoid JSON number precision loss at high values.
 *
 * Mandate lifecycle:
 *   created  → active  (mandate is valid and enforced)
 *   active   → revoked (FIDO2-gated; preserved in Redis for audit)
 */

// ── Mandate record ─────────────────────────────────────────────────

export interface Mandate {
  /** UUID v4 generated at creation */
  mandateId:          string;
  /** Immutable — agent this mandate governs */
  agentId:            string;
  /** Immutable — FIDO2 credential ID hash of the owning wallet */
  ownerWalletId:      string;
  /** Per-transaction USDC ceiling (µUSDC decimal string) */
  maxPerTx?:          string;
  /** Rolling 10-minute USDC ceiling (µUSDC decimal string) */
  maxPer10Min?:       string;
  /** Rolling 24-hour USDC ceiling (µUSDC decimal string) */
  maxPerDay?:         string;
  /** Algorand addresses allowed as recipients; absent/empty = any */
  allowedRecipients?: string[];
  /** Recurring payment schedule, if configured */
  recurring?:         RecurringConfig;
  /** Unix ms expiry; absent = no expiry */
  expiresAt?:         number;
  /** Lifecycle state */
  status:             "active" | "revoked";
  /** Monotonic; incremented on revoke+reissue */
  version:            number;
  /** Unix ms creation timestamp */
  createdAt:          number;
  /** Key-ID of the MANDATE_SECRET_<kid> used to sign this mandate's HMAC */
  kid:                string;
  /** HMAC-SHA256 over canonical mandate fields (hex) */
  hmac:               string;
}

export interface RecurringConfig {
  /** µUSDC amount per execution (decimal string) */
  amount:          string;
  /** Minimum 60 seconds between executions */
  intervalSeconds: number;
  /** Unix ms of next scheduled execution */
  nextExecution:   number;
}

// ── Mandate evaluation ─────────────────────────────────────────────

export type MandateRejectCode =
  | "MANDATE_NOT_FOUND"
  | "MANDATE_EXPIRED"
  | "MANDATE_REVOKED"
  | "RECIPIENT_NOT_ALLOWED"
  | "MAX_PER_TX_EXCEEDED"
  | "VELOCITY_10M_EXCEEDED"
  | "VELOCITY_24H_EXCEEDED"
  | "RECURRING_NOT_READY"
  | "RECURRING_AMOUNT_MISMATCH";

export interface MandateEvalResult {
  allowed:   boolean;
  code?:     MandateRejectCode;
  message?:  string;
}

// ── A2A protocol types ─────────────────────────────────────────────

/** A2A Agent Card — served at /.well-known/agent-card.json */
export interface A2AAgentCard {
  name:         string;
  description:  string;
  url:          string;
  version:      string;
  capabilities: string[];
  extensions: {
    x402:  X402Extension;
    ap2:   AP2Extension;
    a2a:   A2AExtension;
  };
}

export interface X402Extension {
  protocol:    "x402-v1";
  network:     string;
  assetId:     number;
  asset:       "USDC";
  tollAmount:  string;
  payTo:       string;
}

export interface AP2Extension {
  protocol:       "ap2-v0.1";
  mandateTypes:   ("intent" | "cart" | "payment")[];
  fido2Required:  ("mandate_create" | "mandate_revoke" | "custody_transition")[];
  endpoints: {
    createMandate:  string;
    revokeMandate:  string;
    listMandates:   string;
    execute:        string;
  };
}

export interface A2AExtension {
  protocol:   "a2a-v1";
  endpoint:   string;
  messageTypes: ("payment-request" | "payment-result" | "payment-error")[];
}

// ── A2A message shapes ─────────────────────────────────────────────

export interface A2ATask {
  id:       string;
  message:  A2AMessage;
}

export interface A2AMessage {
  role:   "user" | "agent";
  parts:  A2APart[];
}

export type A2APart =
  | { type: "text";            text: string }
  | { type: "payment-request"; paymentRequest: A2APaymentRequest }
  | { type: "payment-result";  paymentResult:  A2APaymentResult }
  | { type: "payment-error";   paymentError:   A2APaymentError };

export interface A2APaymentRequest {
  /** µUSDC amount */
  amount:               string;
  destinationChain:     "ethereum" | "solana" | "base" | "algorand";
  destinationRecipient: string;
  agentId:              string;
  senderAddress:        string;
  /** Optional mandate to use instead of velocity check */
  mandateId?:           string;
}

export interface A2APaymentResult {
  success:       boolean;
  txnId:         string;
  confirmedRound: number;
  settledAt:     string;
}

export interface A2APaymentError {
  code:    string;
  message: string;
}
