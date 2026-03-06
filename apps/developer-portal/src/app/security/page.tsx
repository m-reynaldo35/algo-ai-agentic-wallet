"use client";

import { useEffect, useState, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────

interface SecurityMetrics {
  window:       string;
  eventCounts:  Record<string, number>;
  circuitStatus: {
    open:         boolean;
    failureCount: number;
  };
  massDrain: {
    active: boolean;
    reason: string | null;
  };
  topAlertedAgents: Array<{ agentId: string; count: number }>;
}

interface SecurityEvent {
  type:      string;
  agentId?:  string;
  reason?:   string;
  detail?:   string;
  severity?: string;
  timestamp: number | string;
}

// ── Helpers ────────────────────────────────────────────────────────

function severityBadge(type: string) {
  const t = type.toUpperCase();
  if (t.includes("COMPROMISE") || t.includes("MASS_DRAIN") || t.includes("DRIFT"))
    return <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-900/50 text-red-300 border border-red-800">CRITICAL</span>;
  if (t.includes("VELOCITY") || t.includes("CAP") || t.includes("ANOMALY") || t.includes("CIRCUIT"))
    return <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-900/50 text-amber-300 border border-amber-800">HIGH</span>;
  return <span className="px-2 py-0.5 rounded text-xs font-bold bg-zinc-800 text-zinc-400 border border-zinc-700">INFO</span>;
}

function formatTime(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ── Main page ──────────────────────────────────────────────────────

export default function SecurityPage() {
  const [metrics,   setMetrics]   = useState<SecurityMetrics | null>(null);
  const [events,    setEvents]    = useState<SecurityEvent[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState("");

  // Mass drain clear
  const [showClear,    setShowClear]    = useState(false);
  const [clearKey,     setClearKey]     = useState("");
  const [clearWorking, setClearWorking] = useState(false);
  const [clearError,   setClearError]   = useState("");

  const fetchData = useCallback(async () => {
    try {
      const [mRes, eRes] = await Promise.all([
        fetch("/api/live/security-metrics"),
        fetch("/api/live/security-audit"),
      ]);
      if (mRes.ok) setMetrics(await mRes.json() as SecurityMetrics);
      if (eRes.ok) {
        const d = await eRes.json() as SecurityEvent[] | { events?: SecurityEvent[] };
        setEvents(Array.isArray(d) ? d : (d.events ?? []));
      }
    } catch { /* silent */ }
    finally { setLoading(false); setError(""); }
  }, []);

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 15_000);
    return () => clearInterval(iv);
  }, [fetchData]);

  async function clearMassDrain() {
    setClearWorking(true);
    setClearError("");
    try {
      const res = await fetch("/api/system/mass-drain/clear", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ overrideKey: clearKey }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setShowClear(false);
      setClearKey("");
      await fetchData();
    } catch (err) {
      setClearError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearWorking(false);
    }
  }

  const criticalEvents = [
    "MASS_DRAIN_DETECTED", "DRAIN_VELOCITY_HALT", "SIGNER_KEY_COMPROMISE",
    "RECIPIENT_ANOMALY", "DAILY_CAP_BREACH", "SWEEP_ADDR_TAMPER",
  ];

  const highlightedCounts = metrics
    ? criticalEvents.map((k) => ({ key: k, count: metrics.eventCounts[k] ?? 0 })).filter((e) => e.count > 0)
    : [];

  return (
    <div className="max-w-7xl mx-auto px-6 py-10 space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Security Events</h1>
          <p className="text-zinc-500 text-sm mt-0.5">24-hour security event log, circuit state, and mass-drain monitoring.</p>
        </div>
        <button
          onClick={() => fetchData()}
          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs text-zinc-300 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Mass drain alert banner */}
      {metrics?.massDrain.active && (
        <div className="rounded-lg border border-red-700 bg-red-950/60 px-5 py-4 flex items-start gap-4">
          <span className="w-3 h-3 rounded-full bg-red-400 animate-pulse mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-red-300 font-semibold text-sm">MASS DRAIN DETECTED</p>
            {metrics.massDrain.reason && (
              <p className="text-red-400/70 text-xs mt-0.5 font-mono">{metrics.massDrain.reason}</p>
            )}
          </div>
          <button
            onClick={() => { setShowClear(true); setClearError(""); }}
            className="px-3 py-1.5 bg-red-800 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
          >
            Clear Marker
          </button>
        </div>
      )}

      {/* Circuit breaker */}
      {metrics?.circuitStatus.open && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/50 px-5 py-3 flex items-center gap-3">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
          <p className="text-amber-300 text-sm font-medium">
            Signer circuit breaker OPEN — {metrics.circuitStatus.failureCount} failure{metrics.circuitStatus.failureCount !== 1 ? "s" : ""}
          </p>
        </div>
      )}

      {/* Critical event counts */}
      {!loading && highlightedCounts.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Active Alerts (24h)</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {highlightedCounts.map(({ key, count }) => (
              <div key={key} className="bg-red-950/30 border border-red-800/50 rounded-lg px-4 py-3">
                <p className="text-xs text-red-400/80 font-mono mb-1">{key}</p>
                <p className="text-2xl font-bold text-red-300 tabular-nums">{count}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Event count grid */}
      {metrics && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">All Event Counts (24h)</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {Object.entries(metrics.eventCounts).map(([type, count]) => (
              <div key={type} className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5">
                <p className="text-xs text-zinc-500 font-mono truncate">{type}</p>
                <p className="text-lg font-bold text-white tabular-nums">{count}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top alerted agents */}
      {metrics && metrics.topAlertedAgents.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Top Alerted Agents (24h)</h2>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
                  <th className="text-left py-2.5 px-4">Agent ID</th>
                  <th className="text-right py-2.5 px-4">Alerts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {metrics.topAlertedAgents.map(({ agentId, count }) => (
                  <tr key={agentId} className="hover:bg-zinc-800/30">
                    <td className="py-2.5 px-4 font-mono text-zinc-300 text-xs">{agentId}</td>
                    <td className="py-2.5 px-4 text-right text-red-400 font-bold tabular-nums">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent security audit events */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Recent Security Events</h2>
        {loading ? (
          <div className="flex justify-center p-8">
            <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
          </div>
        ) : error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : events.length === 0 ? (
          <p className="text-zinc-500 text-sm">No security events in the last 24 hours.</p>
        ) : (
          <div className="space-y-2">
            {events.slice(0, 50).map((ev, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 flex items-start gap-3">
                <div className="mt-0.5">{severityBadge(ev.type)}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-zinc-200 text-xs font-mono font-semibold">{ev.type}</p>
                  {ev.agentId && <p className="text-zinc-500 text-xs mt-0.5">Agent: {ev.agentId}</p>}
                  {(ev.reason || ev.detail) && (
                    <p className="text-zinc-400 text-xs mt-0.5">{ev.reason ?? ev.detail}</p>
                  )}
                </div>
                <span className="text-zinc-600 text-xs whitespace-nowrap shrink-0">{formatTime(ev.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mass drain clear dialog */}
      {showClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-white font-semibold">Clear Mass Drain Marker</h3>
            <p className="text-zinc-400 text-sm">This clears the mass-drain halt flag. Ensure the threat has been fully investigated before clearing.</p>
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Override Key <span className="text-zinc-600">(HALT_OVERRIDE_KEY)</span></label>
              <input
                type="password"
                value={clearKey}
                onChange={(e) => setClearKey(e.target.value)}
                placeholder="Required"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
              />
            </div>
            {clearError && (
              <p className="text-red-400 text-sm rounded bg-red-950/40 border border-red-800 px-3 py-2">{clearError}</p>
            )}
            <div className="flex gap-3">
              <button onClick={() => { setShowClear(false); setClearError(""); setClearKey(""); }}
                className="flex-1 px-4 py-2 text-sm text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors">
                Cancel
              </button>
              <button
                disabled={clearWorking || !clearKey}
                onClick={clearMassDrain}
                className="flex-1 px-4 py-2 text-sm font-semibold bg-red-700 hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {clearWorking ? "Clearing…" : "Confirm Clear"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
