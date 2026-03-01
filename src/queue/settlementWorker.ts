/**
 * Settlement Worker
 *
 * Polls the queue, broadcasts signed transactions to Algorand,
 * and updates job status. Runs as a background loop — either
 * embedded in the API process or as a standalone worker process.
 *
 * Throughput: one worker handles ~6 jobs/min (Algorand ~4s/block).
 * Scale horizontally by running multiple worker processes — each
 * independently pops from the same Redis queue (no coordination needed).
 */

import algosdk from "algosdk";
import { dequeueJob }                   from "./settlementQueue.js";
import { getJob, updateJob }            from "./jobStore.js";
import { getAlgodClient }               from "../network/nodely.js";
import { extendReservationTTL }         from "../services/executionIdempotency.js";
import { rollbackOutflow }              from "../protection/treasuryOutflowGuard.js";
import { logSettlementSuccess,
         logExecutionFailure }          from "../services/audit.js";
import { config }                       from "../config.js";

const POLL_INTERVAL_MS   = 200;   // how often to check queue when idle
const CONFIRMATION_ROUNDS = 8;    // max Algorand rounds to wait (~36s at 4.5s/round)

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function broadcastWithRetry(
  algod: algosdk.Algodv2,
  concatenated: Uint8Array,
): Promise<string> {
  const MAX_ATTEMPTS = 3;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { txid } = await algod.sendRawTransaction(concatenated).do();
      return txid;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("txn dead")) {
        console.error(`[Worker] txn expired — blob is past lastValid, will not retry`);
        throw err; // expired — do not retry
      }
      lastErr = err instanceof Error ? err : new Error(msg);
      console.warn(`[Worker] broadcast attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`);
      if (attempt < MAX_ATTEMPTS) await sleep(1_000 * 2 ** (attempt - 1)); // 1s, 2s
    }
  }
  throw lastErr;
}

async function processJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) {
    console.warn(`[Worker] Job not found in store: ${jobId}`);
    return;
  }

  console.log(`[Worker] Processing job ${jobId} (agent: ${job.agentId}, sandbox: ${job.sandboxId})`);

  await updateJob(jobId, { status: "broadcasting" });

  const algod = getAlgodClient();

  // Rebuild Uint8Array blobs from base64
  const signedTxns = job.signedTransactions.map(
    (b64) => new Uint8Array(Buffer.from(b64, "base64")),
  );

  // Concatenate into a single buffer for sendRawTransaction
  const totalLen    = signedTxns.reduce((s, t) => s + t.length, 0);
  const concatenated = new Uint8Array(totalLen);
  let offset = 0;
  for (const txn of signedTxns) {
    concatenated.set(txn, offset);
    offset += txn.length;
  }

  // Keep reservation alive during broadcast
  const ttlHeartbeat = setInterval(() => {
    extendReservationTTL(job.sandboxId).catch(() => {});
  }, 60_000);

  try {
    const txid = await broadcastWithRetry(algod, concatenated);
    console.log(`[Worker] Submitted txn: ${txid}`);

    const confirmation = await algosdk.waitForConfirmation(algod, txid, CONFIRMATION_ROUNDS);
    const confirmedRound = Number(confirmation.confirmedRound ?? 0n);

    if (!confirmedRound) {
      throw new Error(`Transaction not confirmed in ${CONFIRMATION_ROUNDS} rounds: ${txid}`);
    }

    clearInterval(ttlHeartbeat);

    await updateJob(jobId, {
      status:         "confirmed",
      txnId:          txid,
      confirmedRound,
      settledAt:      new Date().toISOString(),
    });

    logSettlementSuccess(txid, job.agentId, config.x402.priceMicroUsdc, txid);

    console.log(`[Worker] ✓ Confirmed  job=${jobId}  txn=${txid}  round=${confirmedRound}`);

  } catch (err) {
    clearInterval(ttlHeartbeat);

    const error = err instanceof Error ? err.message : String(err);
    console.error(`[Worker] ✗ Failed    job=${jobId}  error=${error}`);

    // Roll back treasury outflow reservation — nothing settled
    if (job.outflowReservationKey) {
      rollbackOutflow(job.outflowReservationKey).catch(() => {});
    }

    await updateJob(jobId, { status: "failed", error });
    logExecutionFailure(job.agentId, "broadcast", error);
  }
}

/**
 * Start the worker loop. Runs until the abort signal fires.
 * Call once per process (or once per desired concurrency level).
 */
export async function runWorker(signal: AbortSignal): Promise<void> {
  console.log("[Worker] Settlement worker started — polling queue...");

  while (!signal.aborted) {
    try {
      const jobId = await dequeueJob();

      if (!jobId) {
        // Queue empty — wait before polling again
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, POLL_INTERVAL_MS);
          signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
        continue;
      }

      // Process synchronously per worker — for parallelism run multiple workers
      await processJob(jobId);

    } catch (err) {
      console.error("[Worker] Unexpected error in poll loop:", err instanceof Error ? err.message : err);
      // Brief pause to avoid tight error loops
      await new Promise(r => setTimeout(r, 1_000));
    }
  }

  console.log("[Worker] Settlement worker stopped.");
}
