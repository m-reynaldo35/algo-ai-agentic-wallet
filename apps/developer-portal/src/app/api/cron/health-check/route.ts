import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const API_URL = process.env.API_URL || "https://ai-agentic-wallet.com";
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET(request: Request) {
  // Verify Vercel cron authorization in production
  const authHeader = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const redis = getRedis();
  const now = Date.now();
  let status: "ok" | "degraded" | "down" = "down";
  let detail = "";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(`${API_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      status = data.status === "ok" ? "ok" : "degraded";
      detail = `Round: ${data.node?.latestRound || "unknown"}`;
    } else {
      status = "degraded";
      detail = `HTTP ${res.status}`;
    }
  } catch (err) {
    status = "down";
    detail = err instanceof Error ? err.message : "Unreachable";
  }

  const entry = { status, detail, checkedAt: new Date(now).toISOString() };

  if (redis) {
    // Update latest health status
    await redis.set("x402:health:latest", JSON.stringify(entry)).catch(() => {});

    // Push to history sorted set (capped at 288 = 24h at 5min intervals)
    await redis
      .zadd("x402:health:history", { score: now, member: JSON.stringify(entry) })
      .then(() => redis.zremrangebyrank("x402:health:history", 0, -289))
      .catch(() => {});
  }

  // Fire alert webhook on degraded/down
  if (status !== "ok" && ALERT_WEBHOOK_URL) {
    const emoji = status === "down" ? "🔴" : "🟡";
    fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `${emoji} **x402 API ${status.toUpperCase()}** — ${detail}\nChecked: ${entry.checkedAt}`,
      }),
    }).catch(() => {});
  }

  return NextResponse.json(entry);
}
