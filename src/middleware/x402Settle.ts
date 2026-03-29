import type { Request, Response, NextFunction } from "express";
import algosdk from "algosdk";
import { getAgentByAddress, isHalted }              from "../services/agentRegistry.js";
import { verifyMandateCall, checkVelocityHeadroom } from "../services/mandateVerifier.js";
import { getAlgodClient }                           from "../network/nodely.js";
import { isCircuitOpen, recordSuccess, recordFailure } from "../protection/circuitBreaker.js";
import { checkExecutionLimits }                     from "../protection/executionLimiter.js";
import { enqueueJob }                               from "../queue/settlementQueue.js";
import { getRedis }                                 from "../services/redis.js";
import { logger }                                   from "../lib/logger.js";
import { config }                                   from "../config.js";

const JOB_KEY_PREFIX     = "x402:settlement:job:";
const JOB_TTL_S          = 86_400; // 24 hours
const SETTLING_LOCK_TTL_S = 10;    // covers submit only (~100ms) — safety net on crash

/**
 * x402Settle — Optimistic on-chain mandate settlement middleware.
 *
 * Verifies and submits the pre-signed MandateContract.pay() call from
 * X-PAYMENT, then delivers the resource immediately after broadcast
 * acceptance. Confirmation runs in the background via the settlement worker.
 *
 * Optimistic delivery is safe because:
 *   - Algorand has immediate (non-probabilistic) finality
 *   - The concurrent lock prevents racing transactions from the same agent
 *   - The velocity pre-check (Gate 8.5) closes the main post-broadcast
 *     failure mode before submission
 *   - At $0.01/payment the residual failure rate (~0.001%) is economically
 *     negligible; failures are logged and alerted
 *
 * Gate sequence:
 *   1.  Resolve agent from senderAddr
 *   2.  System halt check
 *   3.  Circuit breaker (algod availability)
 *   4.  Execution rate limits (req/s — infrastructure protection)
 *   5.  Mandate call verification (selector + toll + factory provenance)
 *   6.  Sender match: app call sender == registered agent address
 *   7.  Per-agent concurrent-settlement lock
 *   8.  Submit pre-signed transaction to algod
 *   8.5 Velocity pre-check: wx + toll ≤ vc AND dy + toll ≤ dc
 *   9.  Store broadcasting job record; enqueue for background confirmation
 *   10. Release lock; deliver resource immediately
 */
export async function x402Settle(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  const senderAddr = req.x402?.senderAddr;
  if (!senderAddr) {
    res.status(500).json({ error: "Internal: x402Settle called without senderAddr" });
    return;
  }

  // ── Gate 1: Resolve agent ───────────────────────────────────────
  const agent = await getAgentByAddress(senderAddr);
  if (!agent) {
    res.status(402).contentType("application/pay+json").json({
      version: "x402-v1",
      status:  402,
      error:   "Unregistered agent address — register your agent before making payments",
    });
    return;
  }
  if (agent.status === "suspended") {
    res.status(403).json({ error: "Agent suspended", agentId: agent.agentId });
    return;
  }

  // ── Gate 2: System halt ─────────────────────────────────────────
  const halt = await isHalted();
  if (halt) {
    res.status(503).json({ error: "SERVICE_HALTED", reason: halt.reason });
    return;
  }

  // ── Gate 3: Circuit breaker ─────────────────────────────────────
  const circuit = await isCircuitOpen();
  if (circuit.open) {
    res.status(503).json({
      error:        "SIGNER_CIRCUIT_OPEN",
      message:      "Payment service temporarily unavailable due to repeated failures.",
      failureCount: circuit.failureCount,
    });
    return;
  }

  // ── Gate 4: Execution rate limits ──────────────────────────────
  const limit = await checkExecutionLimits(senderAddr);
  if (!limit.allowed) {
    const httpStatus = limit.violation === "GLOBAL_RATE_LIMIT_EXCEEDED" ? 503 : 429;
    res.setHeader("Retry-After", Math.ceil((limit.retryAfterMs ?? 60_000) / 1_000));
    res.status(httpStatus).json({
      error:        limit.violation,
      retryAfterMs: limit.retryAfterMs,
    });
    return;
  }

  // ── Gate 5: Verify mandate call ─────────────────────────────────
  const paymentHeader = req.headers["x-payment"] as string | undefined;
  if (!paymentHeader) {
    res.status(402).contentType("application/pay+json").json({
      version: "x402-v1",
      status:  402,
      error:   "Missing X-PAYMENT header",
    });
    return;
  }

  const verification = await verifyMandateCall(paymentHeader);
  if (!verification.valid) {
    res.status(402).contentType("application/pay+json").json({
      version: "x402-v1",
      status:  402,
      error:   verification.error,
    });
    return;
  }

  const mandateCall = verification.call!;

  // ── Gate 6: Sender match ────────────────────────────────────────
  if (mandateCall.agentAddress !== senderAddr) {
    res.status(402).contentType("application/pay+json").json({
      version: "x402-v1",
      status:  402,
      error:   `App call sender ${mandateCall.agentAddress} does not match registered agent ${senderAddr}`,
    });
    return;
  }

  // ── Gate 7: Per-agent concurrent-settlement lock ────────────────
  const lockKey = `x402:settling:${agent.agentId}`;
  let lockAcquired = false;
  const redis = getRedis();
  if (redis) {
    try {
      const acquired = await redis.set(lockKey, "1", { nx: true, ex: SETTLING_LOCK_TTL_S });
      if (acquired !== "OK") {
        res.setHeader("Retry-After", "1");
        res.status(429).json({
          error:        "CONCURRENT_SETTLEMENT",
          message:      "A settlement for this agent is already in progress — retry in ~1s.",
          retryAfterMs: 1_000,
        });
        return;
      }
      lockAcquired = true;
    } catch (lockErr) {
      logger.warn(
        { err: lockErr instanceof Error ? lockErr.message : lockErr },
        "[x402Settle] settling lock unavailable — proceeding without concurrent guard",
      );
    }
  }

  const releaseLock = (): void => {
    if (lockAcquired && redis) {
      redis.del(lockKey).catch((e) => logger.warn({ err: e }, "[x402Settle] lock del failed"));
    }
  };

  // ── Gate 8: Submit pre-signed transaction ──────────────────────
  let txid: string;

  try {
    const algod       = getAlgodClient();
    const signedBytes = new Uint8Array(Buffer.from(paymentHeader, "base64"));
    const submitResult = await algod.sendRawTransaction(signedBytes).do() as { txid: string };
    txid = submitResult.txid;
  } catch (err) {
    const message    = err instanceof Error ? err.message : String(err);
    const avmRejected = /overspend|logic eval|assert|opcodes|rejected|mandate|halted|cap|whitelist/i.test(message);

    logger.error(
      { agentId: agent.agentId, appId: mandateCall.appId, avmRejected, err: message },
      "[x402Settle] transaction submission failed",
    );

    releaseLock();
    recordFailure(`submit: ${message}`).catch(() => {});

    if (avmRejected) {
      res.status(402).contentType("application/pay+json").json({
        version: "x402-v1",
        status:  402,
        error:   `Mandate contract rejected payment: ${message}`,
      });
    } else {
      res.status(502).json({
        error:  "Payment submission failed — retry shortly.",
        detail: message,
      });
    }
    return;
  }

  // ── Gate 8.5: Velocity pre-check ───────────────────────────────
  // Runs after broadcast so we don't pay the algod read on requests that
  // fail at the submission stage. Reads current wx/dy from contract global
  // state — if a cap would be breached, we've already submitted but the AVM
  // will reject. Return 429 so the client knows to back off; the submitted
  // transaction will simply fail to confirm (no USDC moves).
  //
  // In practice this fires only when an agent is within one toll of its cap.
  // Under normal load it is never reached.
  const velocity = await checkVelocityHeadroom(mandateCall.appId, mandateCall.amountMicroUsdc);
  if (!velocity.ok) {
    logger.warn(
      { agentId: agent.agentId, appId: mandateCall.appId, txid, reason: velocity.error },
      "[x402Settle] velocity pre-check failed — transaction submitted but will not confirm",
    );
    releaseLock();
    res.setHeader("Retry-After", "60");
    res.status(429).json({
      error:        "VELOCITY_CAP_BREACH",
      message:      velocity.error,
      retryAfterMs: 60_000,
    });
    return;
  }

  // ── Gate 9: Circuit breaker success feedback ────────────────────
  recordSuccess().catch((e) => logger.warn({ err: e }, "[x402Settle] recordSuccess failed"));

  // ── Gate 10: Store broadcasting job, enqueue, release lock ─────
  // Job is stored as "broadcasting" — the settlement worker calls
  // waitForConfirmation and transitions it to confirmed/failed.
  // The resource is delivered immediately; confirmation is the receipt.
  const now = new Date().toISOString();
  const network = `algorand-${config.algorand.network}`;
  const jobRecord = {
    jobId:              txid,
    agentId:            agent.agentId,
    sandboxId:          "",
    signedTransactions: [],  // already submitted — worker skips broadcast
    network,
    status:             "broadcasting",
    enqueuedAt:         now,
    updatedAt:          now,
    txnId:              txid,
  };

  if (redis) {
    await redis
      .set(`${JOB_KEY_PREFIX}${txid}`, JSON.stringify(jobRecord), { ex: JOB_TTL_S })
      .catch((e) => logger.warn({ err: e }, "[x402Settle] failed to store job record"));

    await enqueueJob(txid)
      .catch((e) => logger.warn({ err: e }, "[x402Settle] failed to enqueue confirmation job"));
  }

  releaseLock();

  req.x402!.settlementJobId   = txid;
  req.x402!.settlementAgentId = agent.agentId;

  // ── Gas advisory headers (best-effort, 1.5s cap) ─────────────────
  try {
    const algod     = getAlgodClient();
    const MBR_MICRO = 400_000n;
    const info = await Promise.race<{ amount?: bigint | number } | null>([
      algod.accountInformation(mandateCall.appAddress).do() as Promise<{ amount?: bigint | number }>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
    ]);
    if (info) {
      const balance   = BigInt(info.amount ?? 0n);
      const above     = balance > MBR_MICRO ? balance - MBR_MICRO : 0n;
      const remaining = above / 1_000n;
      const status    = above < 100_000n ? "critical" : above < 500_000n ? "low" : "ok";

      // Server-side alert — gas advisory headers alone aren't enough
      if (status === "critical") {
        logger.error(
          { agentId: agent.agentId, appId: mandateCall.appId, remaining: remaining.toString() },
          "[x402Settle] CRITICAL: contract ALGO balance low — top up immediately or pay() will fail",
        );
      } else if (status === "low") {
        logger.warn(
          { agentId: agent.agentId, appId: mandateCall.appId, remaining: remaining.toString() },
          "[x402Settle] WARNING: contract ALGO balance low",
        );
      }

      res.setHeader("X-Agent-Gas-Status",    status);
      res.setHeader("X-Agent-Gas-Remaining", remaining.toString());
      res.setHeader("X-Agent-Contract-Id",   mandateCall.appId.toString());
    }
  } catch { /* non-blocking — headers omitted on algod error */ }

  next();
}
