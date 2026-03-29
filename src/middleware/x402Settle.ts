import type { Request, Response, NextFunction } from "express";
import algosdk from "algosdk";
import { getAgentByAddress, isHalted } from "../services/agentRegistry.js";
import { verifyMandateCall } from "../services/mandateVerifier.js";
import { getAlgodClient } from "../network/nodely.js";
import { isCircuitOpen, recordSuccess, recordFailure } from "../protection/circuitBreaker.js";
import { checkExecutionLimits } from "../protection/executionLimiter.js";
import { getRedis } from "../services/redis.js";
import { logger } from "../lib/logger.js";

/**
 * TTL for the per-agent concurrent-settlement lock (seconds).
 * Comfortably exceeds the submit + confirm path (~5–15s on-chain).
 * Auto-expires as a safety net if the process crashes mid-flight.
 */
const SETTLING_LOCK_TTL_S = 30;

/**
 * x402Settle — On-chain mandate settlement middleware.
 *
 * MUST run after x402Paywall. Verifies and submits the pre-signed
 * MandateContract.pay() call from the X-PAYMENT header. The resource
 * is never delivered unless the transaction is confirmed on-chain.
 *
 * Under this architecture the server no longer constructs or signs
 * any transaction. All USDC velocity enforcement is delegated to the
 * AVM (per-tx cap, 10-minute window, daily cap, recipient whitelist).
 * The server's responsibility is:
 *   1. Resolve and validate the calling agent
 *   2. Verify the mandate call: method selector, toll params, factory provenance
 *   3. Submit and confirm the pre-signed transaction
 *
 * Gate sequence:
 *   1. Resolve agent from senderAddr
 *   2. System halt check
 *   3. Circuit breaker (algod availability)
 *   4. Execution rate limits (infrastructure protection — req/s, not USDC)
 *   5. Mandate call verification (selector + toll + provenance)
 *   6. Sender match: app call sender == registered agent address
 *   7. Per-agent concurrent-settlement lock
 *   8. Submit pre-signed transaction + wait for confirmation
 *   9. Circuit breaker feedback
 *  10. On AVM rejection: 402 (mandate gate fired — velocity/cap/whitelist)
 *  11. On network error: 502, release lock, record circuit failure
 *  12. On success: release lock, attach txId, call next()
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
  // Infrastructure rate limiting only — USDC velocity is enforced by the AVM.
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
  // Checks: type=appl, ARC-4 selector=pay(), toll params, factory provenance.
  // AVM enforces all mandate gates (velocity, caps, whitelist) at execution.
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
  // The app call must be sent by the registered agent address.
  // Prevents one agent submitting a payment on behalf of another.
  if (mandateCall.agentAddress !== senderAddr) {
    res.status(402).contentType("application/pay+json").json({
      version: "x402-v1",
      status:  402,
      error:   `App call sender ${mandateCall.agentAddress} does not match registered agent ${senderAddr}`,
    });
    return;
  }

  // ── Gate 7: Per-agent concurrent-settlement lock ────────────────
  // Prevents a burst of requests all passing the replay guard independently
  // and each triggering a duplicate on-chain submission.
  // Non-fatal if Redis is unavailable — the AVM rejects duplicate txns.
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

  // ── Gate 8: Submit + confirm ────────────────────────────────────
  // The pre-signed application call is submitted as-is. The AVM enforces
  // all mandate gates (velocity windows, per-tx cap, daily cap, recipient
  // whitelist, halt flag) atomically. If any gate fails, the network
  // rejects the transaction and this request returns 402.
  let txid: string;
  let avmRejected = false;

  try {
    const algod       = getAlgodClient();
    const signedBytes = new Uint8Array(Buffer.from(paymentHeader, "base64"));

    const submitResult = await algod.sendRawTransaction(signedBytes).do() as { txid: string };
    txid = submitResult.txid;

    // Wait up to 5 rounds for on-chain confirmation (~16s worst case).
    // waitForConfirmation throws if the transaction is rejected or times out.
    await algosdk.waitForConfirmation(algod, txid, 5);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Distinguish AVM rejections (mandate gate fired) from network errors.
    // AVM rejections contain error strings from TEAL opcodes or assert failures.
    avmRejected = /overspend|logic eval|assert|opcodes|rejected|mandate|halted|cap|whitelist/i.test(message);

    logger.error(
      { agentId: agent.agentId, appId: mandateCall.appId, avmRejected, err: message },
      "[x402Settle] transaction submission failed",
    );

    releaseLock();

    if (avmRejected) {
      // Mandate gate fired — inform the client which constraint was breached.
      res.status(402).contentType("application/pay+json").json({
        version: "x402-v1",
        status:  402,
        error:   `Mandate contract rejected payment: ${message}`,
      });
    } else {
      // Algod / network error — record for circuit breaker.
      recordFailure(`submit: ${message}`).catch(
        (e) => logger.warn({ err: e }, "[x402Settle] recordFailure failed"),
      );
      res.status(502).json({
        error:  "Payment submission failed — retry shortly.",
        detail: message,
      });
    }
    return;
  }

  // ── Gate 9: Circuit breaker success feedback ────────────────────
  recordSuccess().catch((e) => logger.warn({ err: e }, "[x402Settle] recordSuccess failed"));

  // ── Gate 10: Release lock, attach txId, pass through ────────────
  releaseLock();

  req.x402!.settlementJobId   = txid;
  req.x402!.settlementAgentId = agent.agentId;

  // ── Gas advisory headers (best-effort, 1.5s cap) ─────────────────
  // Reports the MandateContract app account ALGO balance.
  // The app account must maintain enough ALGO to cover:
  //   - Inner transaction fees (1_000 µALGO × 2 per pay() call)
  //   - Minimum balance requirement (opted-in USDC + box storage)
  // Clients reading X-Agent-Gas-Status == "critical" should alert the user
  // to top up the contract account.
  try {
    const algod     = getAlgodClient();
    const MBR_MICRO = 400_000n; // conservative MBR floor: base + USDC opt-in + boxes
    const info = await Promise.race<{ amount?: bigint | number } | null>([
      algod.accountInformation(mandateCall.appAddress).do() as Promise<{ amount?: bigint | number }>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
    ]);
    if (info) {
      const balance   = BigInt(info.amount ?? 0n);
      const above     = balance > MBR_MICRO ? balance - MBR_MICRO : 0n;
      const remaining = above / 1_000n; // capacity in fee units (1_000 µALGO per txn)
      const status    = above < 100_000n ? "critical" : above < 500_000n ? "low" : "ok";
      res.setHeader("X-Agent-Gas-Status",    status);
      res.setHeader("X-Agent-Gas-Remaining", remaining.toString());
      res.setHeader("X-Agent-Contract-Id",   mandateCall.appId.toString());
    }
  } catch { /* non-blocking — headers omitted on algod error */ }

  next();
}
