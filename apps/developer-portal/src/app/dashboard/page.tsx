"use client";

import { useEffect, useState, useCallback } from "react";
import SettlementChart from "@/components/dashboard/SettlementChart";

// ── Types ──────────────────────────────────────────────────────────

interface HaltStatus {
  halted:      boolean;
  haltReason:  string | null;
  activeRotation: null | {
    batchId:        string;
    cohort:         string;
    status:         string;
    confirmedCount: number;
    totalAgents:    number;
  };
}

interface HealthData {
  status:  string;
  halted:  boolean;
  network: string;
  node: {
    provider:      string;
    usingFallback: boolean;
    latestRound:   number;
    indexerOk:     boolean;
  };
  redis: boolean;
}

interface TelemetryMetrics {
  label:  string;
  value:  string;
  delta?: string;
  status: "positive" | "negative" | "neutral";
}

interface TelemetryData {
  metrics:      TelemetryMetrics[];
  recentEvents: unknown[];
}

// ── Sub-components ─────────────────────────────────────────────────

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full shrink-0 ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
      <span className={`text-sm ${ok ? "text-zinc-300" : "text-red-300"}`}>{label}</span>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const [halt,     setHalt]     = useState<HaltStatus | null>(null);
  const [health,   setHealth]   = useState<HealthData | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [loading,  setLoading]  = useState(true);

  // Halt action state
  const [showHaltDialog,   setShowHaltDialog]   = useState(false);
  const [haltReason,       setHaltReason]       = useState("");
  const [overrideKey,      setOverrideKey]      = useState("");
  const [haltWorking,      setHaltWorking]      = useState(false);
  const [haltError,        setHaltError]        = useState("");

  const fetchStatus = useCallback(async () => {
    try {
      const [haltRes, healthRes, telRes] = await Promise.all([
        fetch("/api/system/halt-status"),
        fetch("/api/cron/health-check"),
        fetch("/api/live/telemetry"),
      ]);
      if (haltRes.ok)   setHalt(await haltRes.json() as HaltStatus);
      if (healthRes.ok) setHealth(await healthRes.json() as HealthData);
      if (telRes.ok)    setTelemetry(await telRes.json() as TelemetryData);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchStatus();
    const iv = setInterval(fetchStatus, 15_000);
    return () => clearInterval(iv);
  }, [fetchStatus]);

  async function executeHalt(action: "halt" | "unhalt") {
    setHaltWorking(true);
    setHaltError("");
    try {
      const body: Record<string, string> = { overrideKey };
      if (action === "halt") body.reason = haltReason || "Manual halt via admin portal";
      const res = await fetch(`/api/system/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setShowHaltDialog(false);
      setHaltReason("");
      setOverrideKey("");
      await fetchStatus();
    } catch (err) {
      setHaltError(err instanceof Error ? err.message : String(err));
    } finally {
      setHaltWorking(false);
    }
  }

  const isHalted = halt?.halted ?? false;

  return (
    <div className="max-w-7xl mx-auto px-6 py-10 space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">System Control</h1>
          <p className="text-zinc-500 text-sm mt-0.5">Live system status and operational controls.</p>
        </div>
        <button
          onClick={() => { setShowHaltDialog(true); setHaltError(""); }}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
            isHalted
              ? "bg-emerald-700 hover:bg-emerald-600 text-white"
              : "bg-red-700 hover:bg-red-600 text-white"
          }`}
        >
          {isHalted ? "Unhalt System" : "Halt System"}
        </button>
      </div>

      {/* Halt status banner */}
      {!loading && (
        <div className={`rounded-lg px-5 py-4 border flex items-center gap-4 ${
          isHalted
            ? "bg-red-950/60 border-red-700"
            : "bg-emerald-950/40 border-emerald-800"
        }`}>
          <span className={`w-3 h-3 rounded-full shrink-0 ${isHalted ? "bg-red-400 animate-pulse" : "bg-emerald-400"}`} />
          <div className="flex-1">
            <p className={`font-semibold text-sm ${isHalted ? "text-red-300" : "text-emerald-300"}`}>
              {isHalted ? "SYSTEM HALTED — Payment signing is blocked" : "System operational — Signing pipeline active"}
            </p>
            {isHalted && halt?.haltReason && (
              <p className="text-red-400/70 text-xs mt-0.5 font-mono">{halt.haltReason}</p>
            )}
          </div>
          {isHalted && (
            <span className="text-xs text-red-400 bg-red-900/40 border border-red-800 px-2 py-1 rounded font-mono uppercase tracking-wide">HALTED</span>
          )}
        </div>
      )}

      {/* Health grid */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Subsystem Health</h2>
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 animate-pulse h-20" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              {
                label:  "Algod Node",
                ok:     health?.node !== undefined,
                sub:    health?.node.usingFallback ? "Using fallback" : (health?.node.provider ?? "—"),
              },
              {
                label: "Indexer",
                ok:    health?.node.indexerOk ?? false,
                sub:   health?.node.indexerOk ? "Reachable" : "Unreachable",
              },
              {
                label: "Redis",
                ok:    health?.redis ?? false,
                sub:   health?.redis ? "Connected" : "Disconnected",
              },
              {
                label: "Signing Pipeline",
                ok:    !isHalted,
                sub:   isHalted ? "HALTED" : "Active",
              },
            ].map(({ label, ok, sub }) => (
              <div key={label} className={`bg-zinc-900 border rounded-lg p-4 ${ok ? "border-zinc-800" : "border-red-800/60"}`}>
                <StatusDot ok={ok} label={label} />
                <p className="text-xs text-zinc-600 mt-1.5 pl-4">{sub}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Network + round info */}
      {health && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
            <p className="text-xs text-zinc-500 mb-1">Network</p>
            <p className="text-white font-mono text-sm font-semibold capitalize">{health.network ?? "—"}</p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
            <p className="text-xs text-zinc-500 mb-1">Latest Round</p>
            <p className="text-white font-mono text-sm font-semibold">{health.node?.latestRound?.toLocaleString() ?? "—"}</p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
            <p className="text-xs text-zinc-500 mb-1">Algod Provider</p>
            <p className={`font-mono text-sm font-semibold ${health.node?.usingFallback ? "text-amber-400" : "text-white"}`}>
              {health.node?.usingFallback ? "Fallback active" : (health.node?.provider ?? "—")}
            </p>
          </div>
        </div>
      )}

      {/* Telemetry metrics */}
      {telemetry?.metrics && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Live Telemetry</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {telemetry.metrics.map((m) => (
              <div key={m.label} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
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

      {/* Settlement chart */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Settlement Volume</h2>
        <SettlementChart />
      </div>

      {/* Halt / Unhalt dialog */}
      {showHaltDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-white font-semibold text-lg">
              {isHalted ? "Unhalt System" : "Halt System"}
            </h3>
            <p className="text-zinc-400 text-sm">
              {isHalted
                ? "This will resume the signing pipeline. All new payment requests will be processed."
                : "This will immediately block all payment signing. Existing queued jobs will not be processed until unhalted."}
            </p>

            {!isHalted && (
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Halt reason</label>
                <input
                  type="text"
                  value={haltReason}
                  onChange={(e) => setHaltReason(e.target.value)}
                  placeholder="e.g. Suspicious outflow detected"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                />
              </div>
            )}

            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">
                Override Key <span className="text-zinc-600">(HALT_OVERRIDE_KEY)</span>
              </label>
              <input
                type="password"
                value={overrideKey}
                onChange={(e) => setOverrideKey(e.target.value)}
                placeholder="Required to halt or unhalt"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
              />
            </div>

            {haltError && (
              <p className="text-red-400 text-sm rounded bg-red-950/40 border border-red-800 px-3 py-2">{haltError}</p>
            )}

            <div className="flex gap-3 pt-1">
              <button
                onClick={() => { setShowHaltDialog(false); setHaltError(""); setOverrideKey(""); }}
                className="flex-1 px-4 py-2 text-sm text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={haltWorking || !overrideKey}
                onClick={() => executeHalt(isHalted ? "unhalt" : "halt")}
                className={`flex-1 px-4 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  isHalted
                    ? "bg-emerald-700 hover:bg-emerald-600 text-white"
                    : "bg-red-700 hover:bg-red-600 text-white"
                }`}
              >
                {haltWorking ? "Working…" : isHalted ? "Confirm Unhalt" : "Confirm Halt"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
