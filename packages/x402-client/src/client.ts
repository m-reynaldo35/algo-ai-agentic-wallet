import algosdk from "algosdk";
import { requestWithPayment, buildMandatePayCall, resolveAlgodUrl, X402Error } from "./interceptor.js";
import type {
  ClientConfig,
  TradeParams,
  BatchTradeParams,
  AgentActionResponse,
  BatchActionResponse,
  SettlementResult,
  SettlementFailure,
  TradeResult,
  ProgressCallback,
  PayJson,
} from "./types.js";
import { X402ErrorCode } from "./types.js";
import type { PayTerms } from "./interceptor.js";

const DEFAULT_SLIPPAGE_BIPS = 50;
const MAX_BATCH_SIZE = 16;

/**
 * AlgoAgentClient — x402 SDK for AI-to-AI settlement on Algorand
 *
 * Encapsulates the full x402 handshake:
 *   402 bounce → proof generation → sandbox export → settlement
 *
 * Features:
 *   - Automatic 402 handshake absorption
 *   - Retry with exponential backoff
 *   - Cross-chain USDC routing (Ethereum, Solana, Base)
 *   - Batched atomic settlement (up to 16 trades)
 *   - Progress callbacks for streaming pipeline status
 *   - Typed error codes for deterministic error handling
 */
// How long to reuse suggestedParams before re-fetching (~1 Algorand round).
// Our validity window is 15 rounds (~67s), so 4s-stale firstValid is harmless.
const PARAMS_TTL_MS = 4_000;

export class AlgoAgentClient {
  private readonly baseUrl: string;
  private readonly privateKey: Uint8Array;
  private readonly senderAddress: string;
  private readonly mandateAppId: number;
  private readonly slippageBips: number;
  private readonly agentId: string;
  private readonly maxRetries: number;
  private readonly onProgress: ProgressCallback | undefined;

  // ── Option B: persistent algod client ─────────────────────────
  // One instance per AlgoAgentClient — TCP connection reused across payments.
  private readonly algod: algosdk.Algodv2;

  // ── Option A: suggestedParams cache ───────────────────────────
  // Avoids an algod round-trip on every payment after the first.
  private cachedParams: algosdk.SuggestedParams | null = null;
  private paramsFetchedAt = 0;

  // ── Option C: pay-terms cache ─────────────────────────────────
  // After the first 402 probe we know payTo + amount + chain forever
  // (price is fixed at $0.01). Subsequent payments skip the probe entirely.
  private cachedPayTerms: PayTerms | null = null;

  constructor(config: ClientConfig) {
    if (!config.baseUrl) {
      throw new X402Error("baseUrl is required", X402ErrorCode.CONFIG_ERROR);
    }
    if (!config.privateKey || config.privateKey.length !== 64) {
      throw new X402Error(
        "privateKey must be a 64-byte Algorand secret key",
        X402ErrorCode.CONFIG_ERROR,
      );
    }
    if (!config.mandateAppId || config.mandateAppId <= 0) {
      throw new X402Error(
        "mandateAppId is required — deploy a MandateContract first (python deploy.py create-agent)",
        X402ErrorCode.CONFIG_ERROR,
      );
    }

    this.baseUrl       = config.baseUrl.replace(/\/+$/, "");
    this.privateKey    = config.privateKey;
    this.mandateAppId  = config.mandateAppId;
    this.slippageBips  = config.slippageBips ?? DEFAULT_SLIPPAGE_BIPS;
    this.maxRetries    = config.maxRetries ?? 2;
    this.onProgress    = config.onProgress;

    // Derive Algorand address: sk is 64 bytes [seed(32) | pubkey(32)]
    this.senderAddress = algosdk.encodeAddress(config.privateKey.slice(32));
    this.agentId       = `sdk-${this.senderAddress.slice(0, 8)}`;

    // Option B: create persistent algod client
    this.algod = new algosdk.Algodv2("", resolveAlgodUrl(config.network ?? "mainnet"), "");

    // Option B: eager warmup — fire-and-forget TCP+TLS handshake to Nodely
    // so the connection is established before the first payment fires.
    this.algod.getTransactionParams().do()
      .then((p) => { this.cachedParams = p; this.paramsFetchedAt = Date.now(); })
      .catch(() => { /* non-fatal — will retry on first payment */ });
  }

  // ── Option A: cached suggestedParams ──────────────────────────

  private async getParams(): Promise<algosdk.SuggestedParams> {
    if (this.cachedParams && Date.now() - this.paramsFetchedAt < PARAMS_TTL_MS) {
      return this.cachedParams;
    }
    const params = await this.algod.getTransactionParams().do();
    this.cachedParams    = params;
    this.paramsFetchedAt = Date.now();
    return params;
  }

  // ── Single Trade ─────────────────────────────────────────────

  /**
   * Execute a full x402 trade: handshake → sandbox → settlement.
   * Fires onProgress callbacks at each stage if configured.
   */
  async executeTrade(params: TradeParams): Promise<TradeResult> {
    this.emit("handshake", "Initiating x402 handshake...");

    const sandboxResponse = await this.requestSandboxExport(params);

    this.emit("sandbox_ready", "Sandbox sealed — forwarding to executor", {
      sandboxId: sandboxResponse.export.sandboxId,
      txnCount: String(sandboxResponse.export.atomicGroup.txnCount),
    });

    return this.settle(sandboxResponse);
  }

  /**
   * Step 1+2: Hit /api/agent-action, absorb the 402, return the SandboxExport.
   * Useful if you want to inspect the atomic group before settling.
   */
  async requestSandboxExport(params: TradeParams): Promise<AgentActionResponse> {
    const url = `${this.baseUrl}/api/agent-action`;
    const reqBody = JSON.stringify({
      senderAddress: params.senderAddress,
      ...(params.amount !== undefined && { amount: params.amount }),
      ...(params.destinationChain && { destinationChain: params.destinationChain }),
      ...(params.destinationRecipient && { destinationRecipient: params.destinationRecipient }),
    });

    let response: Response;
    try {
      response = await requestWithPayment(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SLIPPAGE-BIPS": String(this.slippageBips),
          },
          body: reqBody,
        },
        this.privateKey,
        params.senderAddress,
        this.mandateAppId,
        this.maxRetries,
      );
    } catch (err) {
      const error = err instanceof X402Error ? err : new X402Error(
        err instanceof Error ? err.message : String(err),
        X402ErrorCode.SANDBOX_ERROR,
      );
      this.emit("failed", `Sandbox request failed: ${error.message}`, { code: error.code });
      throw error;
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({ error: response.statusText }));
      const msg = (errBody as Record<string, string>).error ?? "unknown";
      const error = new X402Error(
        `agent-action failed (${response.status}): ${msg}`,
        X402ErrorCode.SANDBOX_ERROR,
      );
      this.emit("failed", error.message, { statusCode: String(response.status) });
      throw error;
    }

    this.emit("proof_built", "x402 payment proof accepted by server");
    return response.json() as Promise<AgentActionResponse>;
  }

  /**
   * Step 3: Forward a SandboxExport to /api/execute for on-chain settlement.
   */
  async settle(agentActionResponse: AgentActionResponse): Promise<TradeResult> {
    this.emit("settling", "Executing settlement pipeline on-chain...");

    const response = await fetch(`${this.baseUrl}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sandboxExport: agentActionResponse.export,
        agentId: this.agentId,
      }),
    });

    const result = (await response.json()) as TradeResult;

    if (!response.ok || (result as SettlementFailure).error) {
      const failure = result as SettlementFailure;
      const isPolicyBreach = failure.error?.includes("POLICY_BREACH");
      this.emit("failed", failure.error ?? "Settlement failed", {
        stage: failure.failedStage ?? "",
        code: isPolicyBreach ? X402ErrorCode.POLICY_BREACH : X402ErrorCode.SETTLEMENT_ERROR,
      });
      return result;
    }

    const success = result as SettlementResult;
    this.emit("confirmed", "Settlement confirmed on-chain", {
      txnId: success.settlement?.txnId ?? "",
      confirmedRound: String(success.settlement?.confirmedRound ?? ""),
    });

    return result;
  }

  // ── Batch Trade ──────────────────────────────────────────────

  /**
   * Execute multiple trades as a single atomic group.
   * All trades succeed or all revert — zero partial execution risk.
   * Max 16 intents (Algorand atomic group limit).
   */
  async executeBatch(params: BatchTradeParams): Promise<TradeResult> {
    if (params.intents.length > MAX_BATCH_SIZE) {
      throw new X402Error(
        `Batch size ${params.intents.length} exceeds Algorand atomic group limit of ${MAX_BATCH_SIZE}`,
        X402ErrorCode.BATCH_SIZE_EXCEEDED,
      );
    }

    this.emit("handshake", `Initiating batched x402 handshake (${params.intents.length} intents)...`);

    const batchResponse = await this.requestBatchSandboxExport(params);

    this.emit("sandbox_ready", `Batch sealed — ${batchResponse.batchSize} trades in one atomic group`, {
      sandboxId: batchResponse.export.sandboxId,
      batchSize: String(batchResponse.batchSize),
    });

    return this.settle({
      status: batchResponse.status,
      export: batchResponse.export,
      instructions: batchResponse.instructions,
    });
  }

  async requestBatchSandboxExport(params: BatchTradeParams): Promise<BatchActionResponse> {
    const url = `${this.baseUrl}/api/batch-action`;
    const reqBody = JSON.stringify({
      senderAddress: params.senderAddress,
      intents: params.intents,
    });

    let response: Response;
    try {
      response = await requestWithPayment(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SLIPPAGE-BIPS": String(this.slippageBips),
          },
          body: reqBody,
        },
        this.privateKey,
        params.senderAddress,
        this.mandateAppId,
        this.maxRetries,
      );
    } catch (err) {
      const error = err instanceof X402Error ? err : new X402Error(
        err instanceof Error ? err.message : String(err),
        X402ErrorCode.SANDBOX_ERROR,
      );
      this.emit("failed", `Batch sandbox request failed: ${error.message}`, { code: error.code });
      throw error;
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({ error: response.statusText }));
      const msg = (errBody as Record<string, string>).error ?? "unknown";
      const error = new X402Error(
        `batch-action failed (${response.status}): ${msg}`,
        X402ErrorCode.SANDBOX_ERROR,
      );
      this.emit("failed", error.message, { statusCode: String(response.status) });
      throw error;
    }

    this.emit("proof_built", "Batched x402 payment proof accepted by server");
    return response.json() as Promise<BatchActionResponse>;
  }

  // ── Utilities ────────────────────────────────────────────────

  /**
   * Make an x402-payment-gated HTTP request to any path on this client's server.
   * Transparently absorbs any 402 challenge — the caller receives the final response.
   *
   * Optimisations applied automatically:
   *   A — suggestedParams cached 4s (avoids algod round-trip on every payment)
   *   B — persistent algod client + eager warmup at construction
   *   C — speculative payment: after the first 402 probe, subsequent requests skip
   *       the probe entirely and send X-PAYMENT immediately (saves ~150ms/payment)
   *
   * @example
   * const res = await client.fetch("/api/weather", {
   *   method: "POST",
   *   headers: { "Content-Type": "application/json" },
   *   body: JSON.stringify({ city: "Lagos" }),
   * });
   */
  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    // ── Option C: speculative payment ─────────────────────────────
    // If we already know the payment terms (from a prior probe), skip the
    // probe round-trip and send X-PAYMENT immediately. With a fixed price
    // ($0.01) the terms never change, so the cache is effectively permanent.
    if (this.cachedPayTerms) {
      const sp     = await this.getParams();                       // Option A
      const signed = await buildMandatePayCall(
        this.cachedPayTerms, this.privateKey, this.senderAddress, this.mandateAppId, sp,
      );
      const headers = new Headers(init?.headers);
      headers.set("X-PAYMENT", signed);
      const res = await fetch(url, { ...init, headers });

      if (res.status !== 402) return res;

      // Got a 402 back on the speculative attempt. Two possible causes:
      //   1. AVM gate fired (velocity cap, halt, whitelist) — don't retry
      //   2. Server couldn't parse our X-PAYMENT — clear cache and re-probe
      const body = await res.clone().json().catch(() => ({})) as { error?: string };
      if (body.error === "Missing X-PAYMENT header" || body.error === "Cannot decode signed transaction from X-PAYMENT") {
        // Our payment was malformed somehow — invalidate cache and fall through
        this.cachedPayTerms = null;
        this.cachedParams   = null;
      } else {
        // AVM gate or mandate verification failure — surface to caller
        throw new X402Error(
          body.error ?? "Mandate contract rejected payment",
          X402ErrorCode.POLICY_BREACH,
        );
      }
    }

    // ── Probe path: first payment or after cache invalidation ──────
    // Send without X-PAYMENT, handle 402, cache terms for all future calls.
    const probe = await fetch(url, init ?? {});
    if (probe.status !== 402) return probe;

    let payJson: PayJson;
    try {
      payJson = await probe.json() as PayJson;
    } catch {
      throw new X402Error("Failed to parse 402 pay+json body", X402ErrorCode.UNKNOWN);
    }

    if (payJson.version !== "x402-v1") {
      throw new X402Error(`Unsupported x402 version: ${payJson.version}`, X402ErrorCode.UNSUPPORTED_VERSION);
    }
    if (new Date(payJson.expires).getTime() < Date.now()) {
      throw new X402Error("402 offer expired before payment could be built", X402ErrorCode.OFFER_EXPIRED);
    }

    // Cache terms — valid forever with a fixed price
    this.cachedPayTerms = {
      payTo:  payJson.payment.payTo,
      amount: Number(payJson.payment.amount),
      chain:  payJson.network.chain,
    };

    const sp     = await this.getParams();                         // Option A
    const signed = await buildMandatePayCall(
      this.cachedPayTerms, this.privateKey, this.senderAddress, this.mandateAppId, sp,
    );

    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("X-PAYMENT", signed);
    const retryRes = await fetch(url, { ...init, headers: retryHeaders });

    if (retryRes.status === 402) {
      const body = await retryRes.clone().json().catch(() => ({})) as { error?: string };
      throw new X402Error(
        body.error ?? "Mandate contract rejected payment",
        X402ErrorCode.POLICY_BREACH,
      );
    }

    return retryRes;
  }

  /** The Algorand address derived from this client's private key */
  get address(): string {
    return this.senderAddress;
  }

  /** The deterministic agent ID used in audit logs */
  get id(): string {
    return this.agentId;
  }

  private emit(
    stage: Parameters<ProgressCallback>[0]["stage"],
    message: string,
    data?: Record<string, string>,
  ): void {
    this.onProgress?.({ stage, message, ...(data && { data }) });
  }
}
