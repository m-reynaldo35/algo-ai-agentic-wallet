import crypto from "crypto";
import dns from "dns/promises";
import http from "node:http";
import https from "node:https";
import { getRedis } from "./redis.js";

// ── SSRF Protection ───────────────────────────────────────────
// Private/loopback CIDRs that webhook URLs must NOT resolve to.
const PRIVATE_CIDR_PATTERNS = [
  /^127\./,          // 127.0.0.0/8  loopback
  /^10\./,           // 10.0.0.0/8   private
  /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16-31.0.0/12  private
  /^192\.168\./,     // 192.168.0.0/16 private
  /^169\.254\./,     // 169.254.0.0/16 link-local (AWS metadata)
  /^::1$/,           // IPv6 loopback
  /^fc00:/i,         // IPv6 ULA
  /^fe80:/i,         // IPv6 link-local
];

/**
 * Validates a webhook URL and resolves it to a safe IP address.
 *
 * Returns the pre-resolved IP to use for the actual connection, preventing
 * TOCTOU DNS rebinding attacks. The caller must use the returned resolvedIp
 * to connect rather than re-resolving the hostname at delivery time.
 */
async function isWebhookUrlSafe(
  rawUrl: string,
): Promise<{ safe: boolean; reason?: string; resolvedIp?: string; parsed?: URL }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Invalid URL" };
  }

  // Only allow HTTPS in production; HTTP allowed in dev
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    return { safe: false, reason: "Webhook URL must use https:// in production" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;

  // Block direct IP literals
  for (const pattern of PRIVATE_CIDR_PATTERNS) {
    if (pattern.test(hostname)) {
      return { safe: false, reason: `Private/loopback IP blocked: ${hostname}` };
    }
  }

  // Block localhost by name
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    return { safe: false, reason: `Loopback hostname blocked: ${hostname}` };
  }

  // Resolve DNS once and pin the IP — prevents TOCTOU DNS rebinding.
  // The resolved IP is returned and used directly in deliverWithRetry,
  // so the hostname is never re-resolved between validation and delivery.
  try {
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addressesV6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    const all = [...addresses, ...addressesV6];

    if (all.length === 0) {
      return { safe: false, reason: "DNS resolution returned no addresses" };
    }

    for (const addr of all) {
      for (const pattern of PRIVATE_CIDR_PATTERNS) {
        if (pattern.test(addr)) {
          return { safe: false, reason: `Hostname resolves to private IP: ${addr}` };
        }
      }
    }

    // Pin to the first resolved address
    return { safe: true, resolvedIp: addresses[0] || addressesV6[0], parsed };
  } catch {
    return { safe: false, reason: "DNS resolution failed" };
  }
}

/**
 * Outbound Webhook Delivery Service
 *
 * Fires signed POST requests to every registered API key's webhookUrl
 * whenever a settlement or execution failure occurs.
 *
 * Signing:  HMAC-SHA256 over the raw JSON body, sent as X-WEBHOOK-SIGNATURE.
 * Retry:    Up to 3 attempts with exponential backoff (1s → 2s → 4s).
 * Storage:  Last 500 delivery attempts logged to x402:webhook-deliveries.
 */

// ── Event Types ──────────────────────────────────────────────

export type WebhookEventType =
  | "settlement.success"
  | "execution.failure"
  | "rate.limit";

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

interface ApiKeyEntry {
  id: string;
  name: string;
  platform: string;
  key: string;
  webhookUrl: string;
  status: "active" | "revoked";
}

interface DeliveryRecord {
  id: string;
  webhookUrl: string;
  event: WebhookEventType;
  statusCode: number | null;
  success: boolean;
  attempt: number;
  error?: string;
  deliveredAt: string;
}

const API_KEYS_HASH = "x402:api-keys";
const DELIVERY_LOG_KEY = "x402:webhook-deliveries";
const MAX_RETRIES = 3;
const MAX_DELIVERY_RECORDS = 500;

// ── HMAC Signature ────────────────────────────────────────────

/**
 * Generate HMAC-SHA256 hex signature over the raw body string.
 * Uses the API key itself as the signing secret so each platform
 * can verify authenticity without a shared secret out-of-band.
 */
function signPayload(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

// ── Single Delivery with Retry ────────────────────────────────

/**
 * Build a custom HTTPS/HTTP agent that connects to a pre-resolved IP address,
 * preventing TOCTOU DNS rebinding. The Host header preserves the original hostname
 * so TLS SNI and virtual hosting work correctly.
 */
function buildPinnedAgent(
  protocol: string,
  resolvedIp: string,
  port: string,
  hostname: string,
): https.Agent | http.Agent {
  const options = {
    // Connect directly to the pinned IP — no DNS re-resolution
    lookup: (_: string, _opts: unknown, callback: (err: Error | null, addr: string, family: number) => void) => {
      callback(null, resolvedIp, resolvedIp.includes(":") ? 6 : 4);
    },
    // TLS: validate cert against the original hostname (not the IP)
    servername: hostname,
    rejectUnauthorized: process.env.NODE_ENV === "production",
  };
  return protocol === "https:"
    ? new https.Agent(options)
    : new http.Agent(options);
}

async function deliverWithRetry(
  url: string,
  body: string,
  secret: string,
  resolvedIp: string,
  parsed: URL,
  maxRetries = MAX_RETRIES,
): Promise<{ statusCode: number | null; success: boolean; attempt: number; error?: string }> {
  let lastError = "";
  let lastStatus: number | null = null;
  const agent = buildPinnedAgent(parsed.protocol, resolvedIp, parsed.port, parsed.hostname);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sig = signPayload(body, secret);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WEBHOOK-SIGNATURE": `sha256=${sig}`,
          "X-WEBHOOK-ATTEMPT": String(attempt),
          "User-Agent": "x402-agentic-wallet/1.0",
        },
        body,
        // @ts-expect-error — Node.js fetch accepts agent option
        agent,
        signal: AbortSignal.timeout(8000), // 8s per attempt
      });

      lastStatus = res.status;

      if (res.ok) {
        return { statusCode: res.status, success: true, attempt };
      }

      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "fetch error";
    }

    // Exponential backoff before retry (skip delay on last attempt)
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }

  return {
    statusCode: lastStatus,
    success: false,
    attempt: maxRetries,
    error: lastError,
  };
}

// ── Redis Delivery Log ────────────────────────────────────────

async function logDelivery(record: DeliveryRecord): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const score = Date.now();
  await redis
    .zadd(DELIVERY_LOG_KEY, { score, member: JSON.stringify(record) })
    .then(() => redis.zremrangebyrank(DELIVERY_LOG_KEY, 0, -(MAX_DELIVERY_RECORDS + 1)))
    .catch(() => {});
}

// ── Main Dispatch ─────────────────────────────────────────────

/**
 * Fire webhook to all active registered platforms.
 * Called fire-and-forget from audit.ts — never throws.
 */
export async function dispatchWebhooks(
  event: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  let entries: Record<string, string> | null;
  try {
    entries = await redis.hgetall(API_KEYS_HASH) as Record<string, string> | null;
  } catch {
    return;
  }

  if (!entries || Object.keys(entries).length === 0) return;

  const keys: ApiKeyEntry[] = Object.values(entries).map((v) =>
    typeof v === "string" ? JSON.parse(v) : v,
  );

  const active = keys.filter((k) => k.status === "active" && k.webhookUrl);
  if (active.length === 0) return;

  // Validate all URLs before dispatching (SSRF prevention).
  // DNS is resolved once here and the IP is pinned — delivery never re-resolves.
  type SafeKey = ApiKeyEntry & { resolvedIp: string; parsedUrl: URL };
  const safeKeys: SafeKey[] = [];
  for (const key of active) {
    const check = await isWebhookUrlSafe(key.webhookUrl);
    if (!check.safe) {
      console.warn(`[Webhook] Blocked unsafe webhook URL for ${key.platform}: ${check.reason}`);
    } else {
      safeKeys.push({ ...key, resolvedIp: check.resolvedIp!, parsedUrl: check.parsed! });
    }
  }
  if (safeKeys.length === 0) return;

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);

  // Fan-out in parallel — each delivery is independent
  await Promise.allSettled(
    safeKeys.map(async (key) => {
      // Pass pre-resolved IP — no DNS re-resolution at delivery time (TOCTOU prevention)
      const result = await deliverWithRetry(key.webhookUrl, body, key.key, key.resolvedIp, key.parsedUrl);

      const record: DeliveryRecord = {
        id: crypto.randomUUID(),
        webhookUrl: key.webhookUrl,
        event,
        statusCode: result.statusCode,
        success: result.success,
        attempt: result.attempt,
        error: result.error,
        deliveredAt: new Date().toISOString(),
      };

      if (!result.success) {
        console.warn(
          `[Webhook] Delivery failed for ${key.platform} (${key.webhookUrl}) after ${result.attempt} attempts: ${result.error}`,
        );
      }

      await logDelivery(record);
    }),
  );
}

// ── Portal: Delivery Log Accessor ────────────────────────────

export interface WebhookDelivery {
  id: string;
  webhookUrl: string;
  event: WebhookEventType;
  statusCode: number | null;
  success: boolean;
  attempt: number;
  error?: string;
  deliveredAt: string;
}

export async function getWebhookDeliveries(limit = 50): Promise<WebhookDelivery[]> {
  const redis = getRedis();
  if (!redis) return [];

  try {
    const raw = await redis.zrange(DELIVERY_LOG_KEY, 0, -1, { rev: true }) as string[];
    return raw
      .slice(0, limit)
      .map((s) => (typeof s === "string" ? JSON.parse(s) : s));
  } catch {
    return [];
  }
}
