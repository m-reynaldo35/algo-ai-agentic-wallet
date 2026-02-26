/**
 * Telemetry Sink — External Log Ingest
 *
 * Forwards structured security events to an external observability platform
 * so operators can triage incidents without a Railway log aggregator.
 *
 * Supported backends (auto-detected from env vars):
 *   Axiom    — AXIOM_TOKEN + AXIOM_DATASET
 *              POST https://api.axiom.co/v1/datasets/{dataset}/ingest
 *   Datadog  — DATADOG_API_KEY + DATADOG_SITE (e.g. "datadoghq.com")
 *              POST https://http-intake.logs.{site}/api/v2/logs
 *
 * Batching policy:
 *   Flushes automatically every 10 s OR when the buffer reaches 50 events,
 *   whichever comes first. Fire-and-forget on each flush — telemetry failure
 *   must NEVER propagate back to the signing pipeline.
 *
 * Module 8 — Telemetry Sink
 */

// ── Types ──────────────────────────────────────────────────────────

interface TelemetryEvent {
  [key: string]: unknown;
}

// ── Config ─────────────────────────────────────────────────────────

const BATCH_SIZE  = 50;
const FLUSH_MS    = 10_000;

// ── Internal state ─────────────────────────────────────────────────

const buffer: TelemetryEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;

// ── Backend detection ──────────────────────────────────────────────

function getAxiomConfig(): { token: string; dataset: string } | null {
  const token   = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET;
  if (!token || !dataset) return null;
  return { token, dataset };
}

function getDatadogConfig(): { apiKey: string; site: string } | null {
  const apiKey = process.env.DATADOG_API_KEY;
  const site   = process.env.DATADOG_SITE;
  if (!apiKey || !site) return null;
  return { apiKey, site };
}

// ── Flush logic ────────────────────────────────────────────────────

async function sendToAxiom(events: TelemetryEvent[], token: string, dataset: string): Promise<void> {
  await fetch(`https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body:   JSON.stringify(events),
    signal: AbortSignal.timeout(8_000),
  });
}

async function sendToDatadog(events: TelemetryEvent[], apiKey: string, site: string): Promise<void> {
  const logs = events.map((e) => ({
    message: JSON.stringify(e),
    service: "x402-wallet",
    ...e,
  }));
  await fetch(`https://http-intake.logs.${site}/api/v2/logs`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY":   apiKey,
    },
    body:   JSON.stringify(logs),
    signal: AbortSignal.timeout(8_000),
  });
}

async function flushToBackend(events: TelemetryEvent[]): Promise<void> {
  const axiom   = getAxiomConfig();
  const datadog = getDatadogConfig();

  if (!axiom && !datadog) return; // no backend configured — silently skip

  const sends: Promise<void>[] = [];

  if (axiom) {
    sends.push(sendToAxiom(events, axiom.token, axiom.dataset));
  }
  if (datadog) {
    sends.push(sendToDatadog(events, datadog.apiKey, datadog.site));
  }

  // Run all sends in parallel, swallow all errors
  await Promise.allSettled(sends);
}

// ── Internal flush (drain buffer) ─────────────────────────────────

async function doFlush(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  // Fire-and-forget — telemetry must not throw
  flushToBackend(batch).catch(() => {});
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    doFlush().catch(() => {});
  }, FLUSH_MS);
  // Don't hold the process open for telemetry
  flushTimer.unref?.();
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Ingest a single event into the telemetry buffer.
 *
 * Non-blocking — returns immediately. The event is flushed to the
 * configured backend either when the buffer reaches BATCH_SIZE or
 * when the 10 s flush timer fires.
 *
 * Never throws. Telemetry failure must not block the signing pipeline.
 */
export function ingest(event: TelemetryEvent): void {
  try {
    buffer.push({ ...event, _ingestedAt: new Date().toISOString() });
    if (buffer.length >= BATCH_SIZE) {
      // Drain immediately — don't wait for the timer
      doFlush().catch(() => {});
    } else {
      scheduleFlush();
    }
  } catch {
    // Never throw from telemetry
  }
}

/**
 * Flush the buffer immediately.
 *
 * Call this at graceful shutdown to avoid losing the last batch.
 * Safe to call even when no backend is configured.
 */
export async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await doFlush();
}
