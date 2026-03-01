/**
 * Standalone Settlement Worker
 *
 * Run additional worker processes to scale throughput horizontally.
 * Each worker independently polls the Redis queue and broadcasts transactions.
 *
 * Usage:
 *   npm run worker
 *
 * On Railway: add a second service with start command "npm run worker".
 * Workers share the same Redis queue — no coordination needed.
 */

import "dotenv/config";
import { runWorker } from "../src/queue/settlementWorker.js";

const abort = new AbortController();

process.on("SIGTERM", () => { console.log("[Worker] SIGTERM — shutting down"); abort.abort(); });
process.on("SIGINT",  () => { console.log("[Worker] SIGINT  — shutting down"); abort.abort(); });

runWorker(abort.signal).catch((err) => {
  console.error("[Worker] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
