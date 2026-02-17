"use client";

import { useEffect, useState } from "react";

interface MetricCard {
  label: string;
  value: string;
  delta?: string;
  status: "positive" | "negative" | "neutral";
}

interface AuditEvent {
  event: string;
  txnId?: string;
  agentId: string;
  tollAmountMicroUsdc?: number;
  failedStage?: string;
  error?: string;
  settledAt?: string;
  timestamp?: string;
  oracleContext?: {
    assetPair: string;
    goraConsensusPrice: string;
    goraTimestamp: number;
    goraTimestampISO: string;
    slippageDelta: number;
  };
}

/**
 * TelemetryMetrics — Real-Time x402 Protocol Dashboard
 *
 * Fetches and displays pino JSON audit logs, graphing:
 *   - Total USDC Revenue (settlement.success events)
 *   - Blocked Replay Attacks (execution.failure where stage=validation)
 *   - Gora Oracle price at time of last settlement
 *   - Active agent count
 */
export default function TelemetryMetrics() {
  const [metrics, setMetrics] = useState<MetricCard[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchTelemetry() {
      try {
        const res = await fetch("/api/telemetry");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        setMetrics(data.metrics);
        setEvents(data.recentEvents);
      } catch {
        // Fallback to mock data for development
        setMetrics([
          { label: "Total USDC Revenue", value: "$12.45", delta: "+$2.30 today", status: "positive" },
          { label: "Settlements (24h)", value: "124", delta: "+18%", status: "positive" },
          { label: "Blocked Replays", value: "7", delta: "3 today", status: "negative" },
          { label: "Rate Limit Hits", value: "23", delta: "5 unique IPs", status: "neutral" },
          { label: "Gora Oracle Price", value: "0.2850 USDC/ALGO", delta: "3s ago", status: "neutral" },
          { label: "Active Agents", value: "8", delta: "3 new today", status: "positive" },
        ]);
        setEvents([
          { event: "settlement.success", agentId: "sdk-WYQ24WWZ", tollAmountMicroUsdc: 100000, settledAt: new Date().toISOString(), oracleContext: { assetPair: "USDC/ALGO", goraConsensusPrice: "285000", goraTimestamp: Math.floor(Date.now() / 1000) - 3, goraTimestampISO: new Date().toISOString(), slippageDelta: 50 } },
          { event: "execution.failure", agentId: "agent-rogue-01", failedStage: "validation", error: "Signature Replay Detected: nonce has already been used", timestamp: new Date().toISOString() },
          { event: "settlement.success", agentId: "sdk-GOBIB6Q4", tollAmountMicroUsdc: 100000, settledAt: new Date().toISOString() },
        ]);
      } finally {
        setLoading(false);
      }
    }
    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 10_000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div className="animate-pulse text-zinc-400 p-8">Loading telemetry...</div>;
  }

  return (
    <div className="space-y-8">
      {/* Metric Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {metrics.map((m) => (
          <div key={m.label} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <p className="text-sm text-zinc-400 uppercase tracking-wider">{m.label}</p>
            <p className="text-3xl font-mono font-bold text-white mt-2">{m.value}</p>
            {m.delta && (
              <p className={`text-sm mt-1 ${
                m.status === "positive" ? "text-emerald-400" :
                m.status === "negative" ? "text-red-400" :
                "text-zinc-500"
              }`}>
                {m.delta}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Recent Audit Events */}
      <div>
        <h3 className="text-lg font-semibold text-zinc-200 mb-4">Recent Audit Events</h3>
        <div className="space-y-2">
          {events.map((e, i) => (
            <div key={i} className={`border rounded-lg p-4 font-mono text-sm ${
              e.event === "settlement.success"
                ? "border-emerald-800 bg-emerald-950/30"
                : "border-red-800 bg-red-950/30"
            }`}>
              <div className="flex items-center justify-between">
                <span className={e.event === "settlement.success" ? "text-emerald-400" : "text-red-400"}>
                  {e.event}
                </span>
                <span className="text-zinc-500 text-xs">
                  {e.settledAt || e.timestamp}
                </span>
              </div>
              <p className="text-zinc-400 mt-1">Agent: {e.agentId}</p>
              {e.tollAmountMicroUsdc && (
                <p className="text-zinc-500">Toll: {e.tollAmountMicroUsdc / 1e6} USDC</p>
              )}
              {e.error && <p className="text-red-300 mt-1">{e.error}</p>}
              {e.oracleContext && (
                <p className="text-zinc-500">
                  Oracle: {e.oracleContext.assetPair} @ {Number(e.oracleContext.goraConsensusPrice) / 1e6} (δ={e.oracleContext.slippageDelta}bips)
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
