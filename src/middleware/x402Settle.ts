import type { Request, Response, NextFunction } from "express";
import { getAgentByAddress, isHalted } from "../services/agentRegistry.js";
import { constructAtomicGroup } from "../services/transaction.js";
import { executePipeline } from "../executor.js";
import { isCircuitOpen, recordSuccess, recordFailure } from "../protection/circuitBreaker.js";
import { checkExecutionLimits } from "../protection/executionLimiter.js";
import {
  checkAndReserveVelocity,
  rollbackVelocityReservation,
  recordGlobalOutflow,
} from "../protection/velocityEngine.js";
import {
  enforceActiveMandate,
  rollbackMandateVelocity,
} from "../services/mandateEngine.js";
import { getRedis } from "../services/redis.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

/**
 * TTL for the per-agent concurrent-settlement lock (seconds).
 * Must comfortably exceed the sign + enqueue path (~600ms in practice).
 * Auto-expires as a safety net if the process crashes mid-flight.
 */
const SETTLING_LOCK_TTL_S = 15;

/**
 * x402Settle — Inline USDC toll settlement middleware.
 *
 * MUST run after x402Paywall. Executes the USDC toll payment before the
 * route handler delivers any resource. Data is never returned unless payment
 * is committed (signed and enqueued for on-chain settlement).
 *
 * Gate sequence:
 *   1. Resolve agent from senderAddr (reverse address index)
 *   2. System halt check
 *   3. Circuit breaker
 *   4. Execution rate limits (burst + per-agent)
 *   5. Velocity check + atomic reservation
 *   6. Per-agent concurrent-settlement lock (prevents double-pay under burst)
 *   7. Build toll sandbox (constructAtomicGroup)
 *   8. Execute pipeline: validate → auth → sign → enqueue
 *   9. Circuit breaker feedback
 *  10. On failure: release lock, rollback velocity, respond 502 — data NOT delivered
 *  11. On success: release lock, record outflow, attach jobId to req.x402, call next()
 *
 * Mandate note: this middleware enforces the global velocity path only.
 * Named mandates (with per-tx caps, rolling windows, expiry) apply to
 * /api/execute — not to fixed-toll endpoints handled here. This is intentional:
 * the toll is a flat, config-driven fee unrelated to agent-scoped spend limits.
 *
 * Velocity catch behaviour: a transient Redis failure at Gate 5 is non-fatal —
 * the middleware logs and continues. The treasury outflow guard inside the
 * signing service is the hard backstop. This is a deliberate availability
 * tradeoff documented in the ops runbook.
 */
export async function x402Settle(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  const senderAddr = req.x402?.senderAddr;
  if (!senderAddr) {
    // Defensive: x402Paywall must run first and populate senderAddr
    res.status(500).json({ error: "Internal: x402Settle called without senderAddr" });
    return;
  }

  // ── Gate 1: Resolve agent ───────────────────────────────────────
  const agent = await getAgentByAddress(senderAddr);
  if (!agent) {
    res.status(402).contentType("application/pay+json").json({
      version: "x402-v1",
      status: 402,
      error: "Unregistered agent address — register your agent before making payments",
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
      message:      "Signing service temporarily unavailable due to repeated failures.",
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

  // ── Gate 5: Velocity check — mandate path or global path ────────
  //
  // If the agent has active mandates, the toll is enforced against the
  // tightest mandate caps and deducted from the shared mandate velocity
  // windows. This ensures fixed-toll payments count against the owner's
  // configured blast radius — the product guarantee.
  //
  // If the agent has NO active mandates, the global velocity path applies
  // ($50/10min default). This is the legacy behaviour for unmanaged agents.
  //
  // Fail behaviour:
  //   - mandate path: fail-closed on Redis outage (cannot verify caps → block)
  //   - global path:  fail-open on Redis outage (log + proceed; treasury guard backstop)
  const tollMicroUsdc = BigInt(config.x402.priceMicroUsdc);
  let mandateVelKey:  string | undefined; // set when mandate path was used
  let globalVelKey:   string | undefined; // set when global path was used

  try {
    const mandateResult = await enforceActiveMandate(agent.agentId, tollMicroUsdc);

    if (!mandateResult.allowed) {
      // Mandate path — hard rejection (fail-closed)
      const isVelocity =
        mandateResult.code === "VELOCITY_10M_EXCEEDED" ||
        mandateResult.code === "VELOCITY_24H_EXCEEDED";
      res.status(isVelocity ? 402 : 403).json({
        error:   mandateResult.code,
        message: mandateResult.message,
      });
      return;
    }

    if (mandateResult.hadMandate) {
      // Mandate path used — toll counted against mandate windows
      mandateVelKey = mandateResult.reservationKey;
    } else {
      // No active mandates — fall through to global velocity path
      try {
        const velocity = await checkAndReserveVelocity(agent.agentId, tollMicroUsdc);
        if (velocity.serviceUnavailable) {
          res.status(503).json({
            error:      "SERVICE_UNAVAILABLE",
            message:    "Velocity enforcement unreachable — retry shortly.",
            retryAfter: 30,
          });
          return;
        }
        if (velocity.requiresApproval) {
          res.status(402).json({
            error:             "VELOCITY_APPROVAL_REQUIRED",
            message:           "Spend velocity threshold exceeded",
            tenMinTotal:       velocity.tenMinTotal.toString(),
            threshold10m:      velocity.threshold10m.toString(),
            proposedMicroUsdc: tollMicroUsdc.toString(),
          });
          return;
        }
        globalVelKey = velocity.reservationKey;
      } catch (velocityErr) {
        // Non-fatal on the global path — treasury outflow guard is backstop.
        logger.warn(
          { err: velocityErr instanceof Error ? velocityErr.message : velocityErr },
          "[x402Settle] global velocity check threw — proceeding without reservation",
        );
      }
    }
  } catch (mandateErr) {
    // enforceActiveMandate only throws on unexpected errors (not allowed=false).
    // Treat as fail-closed — we cannot determine mandate state.
    logger.error(
      { err: mandateErr instanceof Error ? mandateErr.message : mandateErr },
      "[x402Settle] enforceActiveMandate threw unexpectedly — blocking payment",
    );
    res.status(503).json({ error: "SERVICE_UNAVAILABLE", message: "Mandate enforcement error — retry shortly." });
    return;
  }

  // ── Gate 6: Per-agent concurrent-settlement lock ────────────────
  // Prevents a burst of concurrent requests (each with a unique nonce) from
  // all passing the replay guard independently and charging the agent multiple
  // times for a single intent. One in-flight settlement per agent at a time.
  // Falls through silently if Redis is unavailable — treasury guard is backstop.
  const lockKey = `x402:settling:${agent.agentId}`;
  let lockAcquired = false;
  const redis = getRedis();
  if (redis) {
    try {
      const acquired = await redis.set(lockKey, "1", { nx: true, ex: SETTLING_LOCK_TTL_S });
      if (acquired !== "OK") {
        // Another settlement for this agent is already in-flight.
        if (mandateVelKey) {
          rollbackMandateVelocity(agent.agentId, mandateVelKey).catch(() => undefined);
        } else if (globalVelKey) {
          rollbackVelocityReservation(agent.agentId, globalVelKey).catch(() => undefined);
        }
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
      // Non-fatal: proceed without lock if Redis is unreachable.
      logger.warn(
        { err: lockErr instanceof Error ? lockErr.message : lockErr },
        "[x402Settle] settling lock unavailable — proceeding without concurrent guard",
      );
    }
  }

  /** Releases the settling lock and optionally rolls back whichever velocity reservation was made. */
  const releaseLock = (rollback = false): void => {
    if (lockAcquired && redis) {
      redis.del(lockKey).catch((e) => logger.warn({ err: e }, "[x402Settle] lock del failed"));
    }
    if (rollback) {
      if (mandateVelKey) {
        rollbackMandateVelocity(agent.agentId, mandateVelKey).catch(
          (e) => logger.warn({ err: e }, "[x402Settle] rollbackMandateVelocity failed"),
        );
      } else if (globalVelKey) {
        rollbackVelocityReservation(agent.agentId, globalVelKey).catch(
          (e) => logger.warn({ err: e }, "[x402Settle] rollbackVelocityReservation failed"),
        );
      }
    }
  };

  // ── Gate 7: Build toll sandbox ──────────────────────────────────
  let sandboxExport;
  try {
    sandboxExport = await constructAtomicGroup(senderAddr, config.x402.priceMicroUsdc);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "[x402Settle] constructAtomicGroup failed");
    releaseLock(true);
    res.status(503).json({ error: "Payment setup failed — retry shortly." });
    return;
  }

  // ── Gate 8: Execute pipeline (validate → auth → sign → enqueue) ─
  const result = await executePipeline(sandboxExport, agent.agentId);

  // ── Gate 9: Circuit breaker feedback ───────────────────────────
  if (result.success) {
    recordSuccess().catch((e) => logger.warn({ err: e }, "[x402Settle] recordSuccess failed"));
  } else if (result.failedStage === "sign" || result.failedStage === "broadcast") {
    const isRateLimit = /rate.limit|429/i.test(result.error ?? "");
    if (!isRateLimit) {
      recordFailure(`stage=${result.failedStage}: ${result.error ?? "unknown"}`).catch(
        (e) => logger.warn({ err: e }, "[x402Settle] recordFailure failed"),
      );
    }
  }

  // ── Gate 10: On failure — release lock, rollback velocity, refuse data ─
  if (!result.success) {
    releaseLock(true);
    logger.error(
      { agentId: agent.agentId, stage: result.failedStage, error: result.error },
      "[x402Settle] Pipeline failed — data delivery blocked",
    );
    res.status(502).json({
      error:       "Payment settlement failed — retry shortly.",
      failedStage: result.failedStage,
    });
    return;
  }

  // ── Gate 11: Release lock, record outflow, pass through ─────────
  releaseLock(); // success — no velocity rollback
  recordGlobalOutflow(agent.agentId, tollMicroUsdc).catch(
    (e) => logger.warn({ err: e }, "[x402Settle] recordGlobalOutflow failed"),
  );

  req.x402!.settlementJobId   = result.jobId;
  req.x402!.settlementAgentId = agent.agentId;

  // ── Gas advisory headers (best-effort, 1.5s cap) ────────────────
  // Must be set before next() — the route handler writes the response body.
  // The 1.5s timeout keeps this off the hot path; headers are omitted on
  // algod timeout or error. SDK clients reading parseGasInfo(response) will
  // receive null when omitted, which is a documented no-op.
  try {
    const { getAlgodClient } = await import("../network/nodely.js");
    const algod      = getAlgodClient();
    const MBR_MICRO  = 200_000n;
    const info = await Promise.race<{ amount?: bigint | number } | null>([
      algod.accountInformation(agent.address).do() as Promise<{ amount?: bigint | number }>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
    ]);
    if (info) {
      const balance   = BigInt(info.amount ?? 0n);
      const above     = balance > MBR_MICRO ? balance - MBR_MICRO : 0n;
      const remaining = above / 1_000n;
      const status    = above < 50_000n ? "critical" : above < 200_000n ? "low" : "ok";
      res.setHeader("X-Agent-Gas-Status",    status);
      res.setHeader("X-Agent-Gas-Remaining", remaining.toString());
    }
  } catch { /* non-blocking — header omitted on algod error */ }

  next();
}
