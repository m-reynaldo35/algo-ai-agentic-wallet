// ── Public API ─────────────────────────────────────────────────
export { AlgoAgentClient } from "./client.js";
export { requestWithPayment, X402Error } from "./interceptor.js";

// ── Types (re-exported for downstream autocomplete) ────────────
export type {
  ClientConfig,
  TradeParams,
  BatchTradeParams,
  BatchTradeIntent,
  BatchActionResponse,
  TradeResult,
  PayJson,
  X402PaymentProof,
  SandboxExport,
  AgentActionResponse,
  SettlementResult,
  SettlementFailure,
  ProgressEvent,
  ProgressCallback,
  PipelineStage,
} from "./types.js";

export { X402ErrorCode, DestinationChain } from "./types.js";
