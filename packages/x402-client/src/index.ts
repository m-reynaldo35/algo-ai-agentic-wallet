// ── Public API ─────────────────────────────────────────────────
export { AlgoAgentClient } from "./client.js";
export { requestWithPayment, X402Error } from "./interceptor.js";

// ── Types (re-exported for downstream autocomplete) ────────────
export type {
  ClientConfig,
  TradeParams,
  TradeResult,
  PayJson,
  X402PaymentProof,
  SandboxExport,
  AgentActionResponse,
  SettlementResult,
  SettlementFailure,
} from "./types.js";
