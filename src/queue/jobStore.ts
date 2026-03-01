/**
 * Settlement Job Store
 *
 * Tracks the lifecycle of every async settlement job in Upstash Redis.
 *
 * Key schema:  x402:settlement:job:<jobId>   (hash, TTL 24h)
 * Pub channel: x402:settlement:done:<jobId>  (for SSE push on completion)
 */

import { getRedis } from "../services/redis.js";
import { randomUUID } from "crypto";

export type JobStatus = "queued" | "broadcasting" | "confirmed" | "failed";

export interface SettlementJob {
  jobId: string;
  agentId: string;
  sandboxId: string;
  /** Base64-encoded signed transaction blobs */
  signedTransactions: string[];
  outflowReservationKey?: string;
  network: string;
  status: JobStatus;
  enqueuedAt: string;
  updatedAt: string;
  /** Set on confirmed */
  txnId?: string;
  confirmedRound?: number;
  settledAt?: string;
  /** Set on failed */
  error?: string;
}

const JOB_TTL_S   = 86_400; // 24 hours
const KEY_PREFIX  = "x402:settlement:job:";

function jobKey(jobId: string): string {
  return `${KEY_PREFIX}${jobId}`;
}

export function makeJobId(): string {
  return randomUUID();
}

export async function createJob(
  params: Omit<SettlementJob, "jobId" | "status" | "enqueuedAt" | "updatedAt">,
): Promise<SettlementJob> {
  const redis = getRedis();
  const job: SettlementJob = {
    ...params,
    jobId:      makeJobId(),
    status:     "queued",
    enqueuedAt: new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
  };

  if (redis) {
    await redis.set(jobKey(job.jobId), JSON.stringify(job), { ex: JOB_TTL_S });
  }

  return job;
}

export async function getJob(jobId: string): Promise<SettlementJob | null> {
  const redis = getRedis();
  if (!redis) return null;

  const raw = await redis.get<string>(jobKey(jobId));
  if (!raw) return null;

  // Upstash auto-parses JSON — handle both parsed object and raw string
  if (typeof raw === "object") return raw as unknown as SettlementJob;
  try { return JSON.parse(raw) as SettlementJob; } catch { return null; }
}

export async function updateJob(
  jobId: string,
  patch: Partial<Pick<SettlementJob, "status" | "txnId" | "confirmedRound" | "settledAt" | "error">>,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const existing = await getJob(jobId);
  if (!existing) return;

  const updated: SettlementJob = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await redis.set(jobKey(jobId), JSON.stringify(updated), { ex: JOB_TTL_S });

  // Publish completion event for SSE subscribers
  if (patch.status === "confirmed" || patch.status === "failed") {
    await redis.publish(
      `x402:settlement:done:${jobId}`,
      JSON.stringify({ jobId, status: updated.status, txnId: updated.txnId, error: updated.error }),
    ).catch(() => {}); // pub/sub may not be available on all Upstash plans
  }
}
