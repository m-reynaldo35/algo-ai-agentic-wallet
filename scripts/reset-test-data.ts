#!/usr/bin/env tsx
/**
 * Pre-launch Redis cleanup — deletes all test/dev keys before going live.
 *
 * Deletes:
 *   x402:*          — all payment, agent, halt, replay keys
 *   x402:guardian:* — on-chain monitor totals
 *   x402:treasury:* — outflow guard state
 *   x402:recipient: — anomaly detector state
 *   x402:config:*   — anchored hashes (cold wallet SHA-256, etc.)
 *
 * Usage:
 *   REDIS_URL=redis://... tsx scripts/reset-test-data.ts
 *   REDIS_PRIVATE_URL=redis://... tsx scripts/reset-test-data.ts
 *
 * Add --dry-run to preview which keys would be deleted without deleting them.
 */

import "dotenv/config";
import { Redis as IORedis } from "ioredis";

const DRY_RUN = process.argv.includes("--dry-run");
const redisUrl = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "";

if (!redisUrl) {
  console.error("Set REDIS_PRIVATE_URL or REDIS_URL env var.");
  process.exit(1);
}

const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });

async function scanDelete(pattern: string): Promise<number> {
  let cursor = "0";
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    if (keys.length > 0) {
      if (DRY_RUN) {
        for (const k of keys) console.log("  would delete:", k);
      } else {
        await redis.del(...keys);
      }
      deleted += keys.length;
    }
  } while (cursor !== "0");
  return deleted;
}

const PATTERNS = [
  "x402:*",
];

console.log(DRY_RUN ? "[DRY RUN] Keys that would be deleted:\n" : "Deleting all x402:* keys from Redis...\n");

let total = 0;
for (const pattern of PATTERNS) {
  const count = await scanDelete(pattern);
  console.log(`  ${pattern}: ${count} key(s)`);
  total += count;
}

console.log(`\n${DRY_RUN ? "Would delete" : "Deleted"} ${total} key(s) total.`);

if (!DRY_RUN && total > 0) {
  console.log("\nNext: redeploy the API so it re-anchors the cold wallet hash on first boot.");
}

redis.disconnect();
