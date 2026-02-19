"use client";

import { useEffect, useState } from "react";

interface HealthStatus {
  status: "ok" | "degraded" | "down";
  detail: string;
  checkedAt: string;
}

export default function HealthBanner() {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    async function fetchHealth() {
      try {
        const res = await fetch("/api/live/telemetry");
        if (!res.ok) return;
        // Health status is fetched separately via the cron — check latest
        const healthRes = await fetch("/api/cron/health-check");
        if (healthRes.ok) {
          setHealth(await healthRes.json());
        }
      } catch {
        // Silently fail — banner just won't show
      }
    }
    fetchHealth();
    const interval = setInterval(fetchHealth, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (!health || health.status === "ok") return null;

  const isDown = health.status === "down";

  return (
    <div
      className={`rounded-lg px-4 py-3 mb-6 text-sm font-mono ${
        isDown
          ? "bg-red-950/50 border border-red-800 text-red-300"
          : "bg-amber-950/50 border border-amber-800 text-amber-300"
      }`}
    >
      <span className="font-bold">
        {isDown ? "API DOWN" : "API DEGRADED"}
      </span>
      {" — "}
      {health.detail}
      <span className="text-zinc-500 ml-3">
        Last checked: {new Date(health.checkedAt).toLocaleTimeString()}
      </span>
    </div>
  );
}
