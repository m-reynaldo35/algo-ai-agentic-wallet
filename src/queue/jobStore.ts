/**
 * Settlement Job Store
 *
 * Tracks the lifecycle of every async settlement job in Upstash Redis.
 *
 * Key schema:  x402:settlement:job:<jobId>   (hash, TTL 24h)
 * Pub channel: x402:settlement:done:<jobId>  (for SSE push on completion)
 */

import { getRedis, hmacSign, hmacVerify, HmacIntegrityError } from "../services/redis.js";
import { randomUUID } from "crypto";

export type JobStatus = "queued" | "broadcasting" | "confirmed" | "failed" | "dead";

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
  /** Set on failed / dead */
  error?: string;
  /** S.5: retry tracking */
  retryCount?: number;
  maxRetries?: number;
}

const JOB_TTL_S        = 86_400;     // 24 hours (normal)
const DEAD_JOB_TTL_S   = 7 * 86_400; // 7 days (dead-letter)
const KEY_PREFIX        = "x402:settlement:job:";
const DEAD_LETTER_KEY   = "x402:settlement:dead";

function jobKey(jobId: string): string {
  return `${KEY_PREFIX}${jobId}`;
}

export function makeJobId(): string {
  return randomUUID();
}

const MAX_RETRIES_DEFAULT = 3;

export async function createJob(
  params: Omit<SettlementJob, "jobId" | "status" | "enqueuedAt" | "updatedAt" | "retryCount" | "maxRetries">,
): Promise<SettlementJob> {
  const redis = getRedis();
  const job: SettlementJob = {
    ...params,
    jobId:      makeJobId(),
    status:     "queued",
    retryCount: 0,
    maxRetries: MAX_RETRIES_DEFAULT,
    enqueuedAt: new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
  };

  if (redis) {
    const key = jobKey(job.jobId);
    await redis.set(key, hmacSign(JSON.stringify(job)), { ex: JOB_TTL_S });
  }

  return job;
}

export async function getJob(jobId: string): Promise<SettlementJob | null> {
  const redis = getRedis();
  if (!redis) return null;

  const key = jobKey(jobId);
  const raw = await redis.get<unknown>(key);
  if (!raw) return null;

  const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    const payload = hmacVerify(rawStr, key);
    return typeof payload === "string" ? JSON.parse(payload) as SettlementJob : payload as unknown as SettlementJob;
  } catch (err) {
    if (err instanceof HmacIntegrityError) {
      console.error(`[JobStore] HMAC integrity violation for job ${jobId} — treating as missing`);
      return null;
    }
    if (typeof raw === "object") return raw as unknown as SettlementJob;
    try { return JSON.parse(rawStr) as SettlementJob; } catch { return null; }
  }
}

export async function updateJob(
  jobId: string,
  patch: Partial<Pick<SettlementJob, "status" | "txnId" | "confirmedRound" | "settledAt" | "error" | "retryCount">>,
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

  const key = jobKey(jobId);
  await redis.set(key, hmacSign(JSON.stringify(updated)), { ex: JOB_TTL_S });

  // Publish completion event for SSE subscribers
  if (patch.status === "confirmed" || patch.status === "failed" || patch.status === "dead") {
    await redis.publish(
      `x402:settlement:done:${jobId}`,
      JSON.stringify({ jobId, status: updated.status, txnId: updated.txnId, error: updated.error }),
    ).catch(() => {});
  }
}

/**
 * Move a job to the dead-letter store after exhausting retries (S.5).
 * Stores with 7-day TTL for ops inspection.
 * Adds to dead-letter index set for listing.
 */
export async function moveToDeadLetter(jobId: string, finalError: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const existing = await getJob(jobId);
  if (!existing) return;

  const dead: SettlementJob = {
    ...existing,
    status:    "dead",
    error:     finalError,
    updatedAt: new Date().toISOString(),
  };

  const key = jobKey(jobId);
  await Promise.all([
    redis.set(key, hmacSign(JSON.stringify(dead)), { ex: DEAD_JOB_TTL_S }),
    redis.sadd(DEAD_LETTER_KEY, jobId),
    redis.publish(
      `x402:settlement:done:${jobId}`,
      JSON.stringify({ jobId, status: "dead", error: finalError }),
    ).catch(() => {}),
  ]);

  console.error(`[JobStore] Job ${jobId} moved to dead-letter after ${existing.retryCount ?? 0} retries: ${finalError}`);
}

/** List all dead-letter job IDs (ops inspection endpoint). */
export async function listDeadLetterJobIds(): Promise<string[]> {
  const redis = getRedis();
  if (!redis) return [];
  return redis.smembers(DEAD_LETTER_KEY);
}
