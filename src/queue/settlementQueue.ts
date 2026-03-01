/**
 * Settlement Queue
 *
 * Redis list used as a FIFO queue.
 *   Enqueue: LPUSH x402:settlement:queue <jobId>
 *   Dequeue: RPOP  x402:settlement:queue          (worker polls)
 *
 * Only the jobId is stored in the list — full job data lives in the
 * job store hash (x402:settlement:job:<jobId>). This keeps the list
 * lightweight and lets us inspect/update jobs independently.
 */

import { getRedis } from "../services/redis.js";

const QUEUE_KEY = "x402:settlement:queue";

export async function enqueueJob(jobId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    console.warn("[Queue] Redis not configured — job will not be persisted:", jobId);
    return;
  }
  await redis.lpush(QUEUE_KEY, jobId);
}

/** Returns the next jobId, or null if the queue is empty. */
export async function dequeueJob(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;

  const result = await redis.rpop<string>(QUEUE_KEY);
  if (!result) return null;

  // Upstash may return a parsed value — ensure it's a string
  return typeof result === "string" ? result : String(result);
}

/** Returns current queue depth (for telemetry). */
export async function queueDepth(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  return redis.llen(QUEUE_KEY);
}
