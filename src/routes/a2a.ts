/**
 * A2A Route — Agent-to-Agent x402 Payment Endpoint
 *
 * POST /a2a
 *
 * Open endpoint (no portal auth) — authenticated via mandate check.
 * Accepts A2A messages with payment-request parts, routes them through
 * the x402 execute pipeline (with optional mandate authorization), and
 * returns a payment-result or payment-error part.
 *
 * A2A Agent Card: GET /.well-known/agent-card.json (served by static middleware)
 */

import { Router }               from "express";
import { constructAtomicGroup } from "../services/transaction.js";
import { executePipeline }      from "../executor.js";
import { evaluateMandate }      from "../services/mandateEngine.js";
import { checkAndReserveVelocity, rollbackVelocityReservation, recordGlobalOutflow, sumUsdcAxfers } from "../protection/velocityEngine.js";
import { atomicReserve, completeReservation, releaseReservation, markTxIdSettled } from "../services/executionIdempotency.js";
import type { A2ATask, A2APart, A2APaymentRequest } from "../types/mandate.js";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const task = req.body as A2ATask;

    if (!task?.id || !task?.message?.parts) {
      res.status(400).json({
        error: "Invalid A2A task format — missing id or message.parts",
      });
      return;
    }

    // Find the first payment-request part
    const paymentPart = task.message.parts.find(
      (p: A2APart): p is Extract<A2APart, { type: "payment-request" }> =>
        p.type === "payment-request",
    );

    if (!paymentPart) {
      res.status(400).json({
        error: "No payment-request part found in A2A message",
      });
      return;
    }

    const pr: A2APaymentRequest = paymentPart.paymentRequest;

    // Validate required fields
    if (!pr.senderAddress || !pr.agentId || !pr.destinationRecipient || !pr.destinationChain) {
      res.status(400).json({
        error: "payment-request missing required fields: senderAddress, agentId, destinationChain, destinationRecipient",
      });
      return;
    }

    const amountMicroUsdc = BigInt(pr.amount ?? "0");

    // Build atomic group
    let sandboxExport;
    try {
      sandboxExport = await constructAtomicGroup(
        pr.senderAddress,
        Number(amountMicroUsdc),
        pr.destinationChain,
        pr.destinationRecipient,
      );
    } catch (err) {
      res.status(400).json({
        jsonrpc: "2.0",
        id:      task.id,
        result: {
          id:      task.id,
          status:  { state: "failed" },
          message: {
            role:  "agent",
            parts: [{
              type:         "payment-error",
              paymentError: {
                code:    "BUILD_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            }],
          },
        },
      });
      return;
    }

    const txnBlobs = (sandboxExport?.atomicGroup?.transactions ?? []) as string[];
    const proposedMicroUsdc = sumUsdcAxfers(txnBlobs);

    // Authorization: mandate path or velocity path
    if (pr.mandateId) {
      // Mandate path — evaluate against mandate; no velocity check
      const evalResult = await evaluateMandate(pr.agentId, pr.mandateId, txnBlobs);
      if (!evalResult.allowed) {
        res.status(402).json({
          jsonrpc: "2.0",
          id:      task.id,
          result: {
            id:      task.id,
            status:  { state: "failed" },
            message: {
              role:  "agent",
              parts: [{
                type:         "payment-error",
                paymentError: {
                  code:    evalResult.code ?? "MANDATE_REJECTED",
                  message: evalResult.message ?? "Mandate evaluation rejected",
                },
              }],
            },
          },
        });
        return;
      }
    } else if (proposedMicroUsdc > 0n) {
      // Velocity path — atomic check+reserve
      const velocity = await checkAndReserveVelocity(pr.agentId, proposedMicroUsdc);
      if (velocity.requiresApproval) {
        res.status(402).json({
          jsonrpc: "2.0",
          id:      task.id,
          result: {
            id:      task.id,
            status:  { state: "failed" },
            message: {
              role:  "agent",
              parts: [{
                type:         "payment-error",
                paymentError: {
                  code:    "VELOCITY_APPROVAL_REQUIRED",
                  message: "Spend velocity exceeds threshold",
                },
              }],
            },
          },
        });
        return;
      }
      // Attach reservation key for rollback on pipeline failure
      (req as unknown as Record<string, unknown>)._velocityReservationKey = velocity.reservationKey;
    }

    // ── Idempotency guard: globally-atomic sandboxId reservation ──
    // Mirrors the same SET NX guard in the main execute endpoint.
    // Without this, a2a had zero pipeline-level deduplication.
    const a2aSandboxId: string = sandboxExport?.sandboxId ?? "";
    const reservation = await atomicReserve(a2aSandboxId);
    if (reservation.status === "completed") {
      // Already settled — return cached result as a completed A2A task
      res.setHeader("X-Idempotent-Replay", "true");
      res.json({
        jsonrpc: "2.0",
        id:      task.id,
        result: {
          id:     task.id,
          status: { state: "completed" },
          message: {
            role:  "agent",
            parts: [{ type: "idempotent-replay", data: reservation.cachedResult }],
          },
        },
      });
      return;
    }
    if (reservation.status === "processing") {
      res.status(202).json({
        jsonrpc: "2.0",
        id:      task.id,
        result: {
          id:     task.id,
          status: { state: "submitted" },
          message: {
            role:  "agent",
            parts: [{ type: "status", text: "Settlement in progress — retry in a few seconds" }],
          },
        },
      });
      return;
    }

    // Execute pipeline
    const result = await executePipeline(sandboxExport, pr.agentId);

    if (!result.success) {
      // Release the execution reservation so the client can retry
      releaseReservation(a2aSandboxId).catch(() => {});
      // Roll back velocity reservation so failed attempts don't consume quota
      const reservationKey = (req as unknown as Record<string, unknown>)._velocityReservationKey as string | undefined;
      if (!pr.mandateId && reservationKey) {
        rollbackVelocityReservation(pr.agentId, reservationKey).catch(() => {});
      }
      res.status(502).json({
        jsonrpc: "2.0",
        id:      task.id,
        result: {
          id:      task.id,
          status:  { state: "failed" },
          message: {
            role:  "agent",
            parts: [{
              type:         "payment-error",
              paymentError: {
                code:    result.failedStage ?? "PIPELINE_FAILED",
                message: result.error ?? "Settlement pipeline failed",
              },
            }],
          },
        },
      });
      return;
    }

    // Record global outflow for mass drain tracking (non-mandate path).
    if (!pr.mandateId && proposedMicroUsdc > 0n) {
      recordGlobalOutflow(pr.agentId, proposedMicroUsdc).catch(() => {});
    }

    // Mark execution complete and confirmed txnId as settled
    completeReservation(a2aSandboxId, result).catch(() => {});
    if (result.settlement?.txnId) {
      markTxIdSettled(result.settlement.txnId, {
        agentId:        pr.agentId,
        sandboxId:      a2aSandboxId,
        groupId:        result.settlement.groupId,
        confirmedRound: result.settlement.confirmedRound,
        settledAt:      result.settlement.settledAt,
      }).catch(() => {});
    }

    res.json({
      jsonrpc: "2.0",
      id:      task.id,
      result: {
        id:      task.id,
        status:  { state: "completed" },
        message: {
          role:  "agent",
          parts: [{
            type:          "payment-result",
            paymentResult: {
              success:        true,
              txnId:          result.settlement?.txnId ?? "",
              confirmedRound: result.settlement?.confirmedRound ?? 0,
              settledAt:      result.settlement?.settledAt ?? new Date().toISOString(),
            },
          }],
        },
      },
    });

  } catch (err) {
    console.error("[a2a]", err instanceof Error ? err.message : err);
    res.status(500).json({
      error: "A2A payment processing failed",
    });
  }
});

export default router;
