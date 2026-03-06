"use client";

import { useEffect, useState, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────

interface MetricCard {
  label:  string;
  value:  string;
  delta?: string;
  status: "positive" | "negative" | "neutral";
}

interface TelemetryData {
  metrics:      MetricCard[];
  recentEvents: unknown[];
}

interface VolumePoint {
  date:             string;
  settledCount:     number;
  totalMicroUsdc?:  number;
  totalUsdc?:       number;
}

interface SecurityMetrics {
  massDrain: {
    active: boolean;
    reason: string | null;
  };
  circuitStatus: {
    open:         boolean;
    failureCount: number;
  };
  eventCounts: Record<string, number>;
}

function formatUsdc(micro?: number): string {
  if (micro === undefined) return "—";
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

// ── Main page ──────────────────────────────────────────────────────

export default function TreasuryPage() {
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [volume,    setVolume]    = useState<VolumePoint[]>([]);
  const [security,  setSecurity]  = useState<SecurityMetrics | null>(null);
  const [loading,   setLoading]   = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [tRes, vRes, sRes] = await Promise.all([
        fetch("/api/live/telemetry"),
        fetch("/api/live/settlement-volume"),
        fetch("/api/live/security-metrics"),
      ]);
      if (tRes.ok) setTelemetry(await tRes.json() as TelemetryData);
      if (vRes.ok) {
        const d = await vRes.json() as VolumePoint[] | { data?: VolumePoint[]; points?: VolumePoint[] };
        setVolume(Array.isArray(d) ? d : (d.data ?? d.points ?? []));
      }
      if (sRes.ok) setSecurity(await sRes.json() as SecurityMetrics);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 30_000);
    return () => clearInterval(iv);
  }, [fetchData]);

  // Derived: today's volume
  const today = volume.length > 0 ? volume[volume.length - 1] : null;
  const todayUsdc = today?.totalMicroUsdc ?? (today?.totalUsdc ? today.totalUsdc * 1_000_000 : undefined);
  const todayCount = today?.settledCount ?? 0;

  // 7-day total
  const weekTotal = volume.slice(-7).reduce((sum, p) => sum + (p.totalMicroUsdc ?? (p.totalUsdc ? p.totalUsdc * 1_000_000 : 0)), 0);

  const velAlerts = security?.eventCounts["DRAIN_VELOCITY_HALT"] ?? 0;
  const capBreaches = security?.eventCounts["DAILY_CAP_BREACH"] ?? 0;

  return (
    <div className="max-w-7xl mx-auto px-6 py-10 space-y-8">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Treasury Monitor</h1>
        <p className="text-zinc-500 text-sm mt-0.5">Settlement volume, security circuit status, and daily outflow metrics.</p>
      </div>

      {/* Alert banners */}
      {security?.massDrain.active && (
        <div className="rounded-lg border border-red-700 bg-red-950/60 px-5 py-3 flex items-center gap-3">
          <span className="w-2.5 h-2.5 rounded-full bg-red-400 animate-pulse shrink-0" />
          <p className="text-red-300 text-sm font-semibold">
            Mass drain marker active — signing may be restricted
          </p>
        </div>
      )}
      {security?.circuitStatus.open && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/50 px-5 py-3 flex items-center gap-3">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
          <p className="text-amber-300 text-sm font-medium">
            Signer circuit breaker OPEN — {security.circuitStatus.failureCount} consecutive failures
          </p>
        </div>
      )}

      {/* Volume summary cards */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Settlement Volume</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Today (USDC)",      value: loading ? "…" : formatUsdc(todayUsdc),          color: "text-emerald-400" },
            { label: "Today (txns)",      value: loading ? "…" : todayCount.toString(),           color: "text-white" },
            { label: "7-day (USDC)",      value: loading ? "…" : formatUsdc(weekTotal),           color: "text-emerald-400" },
            { label: "Data points",       value: loading ? "…" : volume.length.toString(),        color: "text-zinc-400" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
              <p className="text-xs text-zinc-500 mb-1">{label}</p>
              <p className={`text-2xl font-bold tabular-nums font-mono ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Security / outflow guard */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Outflow Guard (24h)</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            {
              label: "Velocity Halts",
              value: loading ? "…" : velAlerts.toString(),
              color: velAlerts > 0 ? "text-red-400" : "text-zinc-400",
              bg:    velAlerts > 0 ? "border-red-800/60" : "border-zinc-800",
            },
            {
              label: "Daily Cap Breaches",
              value: loading ? "…" : capBreaches.toString(),
              color: capBreaches > 0 ? "text-red-400" : "text-zinc-400",
              bg:    capBreaches > 0 ? "border-red-800/60" : "border-zinc-800",
            },
            {
              label: "Mass Drain",
              value: security ? (security.massDrain.active ? "ACTIVE" : "Clear") : "—",
              color: security?.massDrain.active ? "text-red-400" : "text-emerald-400",
              bg:    security?.massDrain.active ? "border-red-800/60" : "border-zinc-800",
            },
            {
              label: "Circuit Breaker",
              value: security ? (security.circuitStatus.open ? "OPEN" : "Closed") : "—",
              color: security?.circuitStatus.open ? "text-amber-400" : "text-emerald-400",
              bg:    security?.circuitStatus.open ? "border-amber-800/60" : "border-zinc-800",
            },
          ].map(({ label, value, color, bg }) => (
            <div key={label} className={`bg-zinc-900 border rounded-lg px-4 py-3 ${bg}`}>
              <p className="text-xs text-zinc-500 mb-1">{label}</p>
              <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Live telemetry metrics from backend */}
      {telemetry?.metrics && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Protocol Metrics (Live)</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {telemetry.metrics.map((m) => (
              <div key={m.label} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
                <p className="text-xs text-zinc-500 uppercase tracking-wider">{m.label}</p>
                <p className="text-2xl font-mono font-bold text-white mt-1">{m.value}</p>
                {m.delta && (
                  <p className={`text-xs mt-0.5 ${
                    m.status === "positive" ? "text-emerald-400" :
                    m.status === "negative" ? "text-red-400" : "text-zinc-500"
                  }`}>{m.delta}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Settlement volume table */}
      {volume.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Daily Volume Breakdown</h2>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
                  <th className="text-left py-2.5 px-4">Date</th>
                  <th className="text-right py-2.5 px-4">Settlements</th>
                  <th className="text-right py-2.5 px-4">USDC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {[...volume].reverse().slice(0, 14).map((point, i) => {
                  const usdcMicro = point.totalMicroUsdc ?? (point.totalUsdc ? point.totalUsdc * 1_000_000 : undefined);
                  return (
                    <tr key={i} className="hover:bg-zinc-800/30 transition-colors">
                      <td className="py-2.5 px-4 text-zinc-300 text-xs">{point.date}</td>
                      <td className="py-2.5 px-4 text-right text-zinc-400 tabular-nums text-xs">{point.settledCount}</td>
                      <td className="py-2.5 px-4 text-right text-emerald-400 font-mono font-medium tabular-nums text-xs">{formatUsdc(usdcMicro)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
