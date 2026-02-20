"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { MOCK_EVENTS, type AuditEvent } from "@/lib/mock-data";

type FilterType = "all" | "success" | "failure" | "rate.limit";
type ConnectionState = "connecting" | "live" | "polling" | "paused" | "mock";

export default function EventLog() {
  const [events, setEvents] = useState<AuditEvent[]>(MOCK_EVENTS);
  const [filter, setFilter] = useState<FilterType>("all");
  const [agentSearch, setAgentSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const esRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Prepend a new event (newest first, cap at 200) ─────────────
  const pushEvent = useCallback((raw: unknown) => {
    const e = raw as AuditEvent;
    if (!e || !e.type) return;
    setEvents((prev) => [e, ...prev].slice(0, 200));
  }, []);

  // ── SSE Connection ─────────────────────────────────────────────
  const connectSSE = useCallback(() => {
    if (esRef.current) return;
    setConnState("connecting");

    const es = new EventSource("/api/live/stream");
    esRef.current = es;

    es.addEventListener("settlement.success", (ev) => {
      try { pushEvent(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    es.addEventListener("execution.failure", (ev) => {
      try { pushEvent(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    es.addEventListener("rate.limit", (ev) => {
      try { pushEvent(JSON.parse(ev.data)); } catch { /* ignore */ }
    });

    es.onopen = () => setConnState("live");

    es.onerror = () => {
      es.close();
      esRef.current = null;
      // Fall back to polling when SSE is unavailable (Vercel serverless env)
      setConnState("polling");
      startPollingFallback();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushEvent]);

  // ── Polling Fallback ──────────────────────────────────────────
  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams({ range: "24h", type: "all" });
      const res = await fetch(`/api/live/events?${params}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (data.events?.length > 0) {
        setEvents(data.events);
        setConnState((s) => s === "connecting" ? "polling" : s);
      }
    } catch {
      setConnState("mock");
    }
  }, []);

  const startPollingFallback = useCallback(() => {
    if (pollingRef.current) return;
    void fetchEvents();
    pollingRef.current = setInterval(() => void fetchEvents(), 8_000);
  }, [fetchEvents]);

  // ── Mount ──────────────────────────────────────────────────────
  useEffect(() => {
    connectSSE();
    void fetchEvents(); // Hydrate immediately while SSE connects
    return () => {
      esRef.current?.close();
      esRef.current = null;
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pause / Resume ─────────────────────────────────────────────
  useEffect(() => {
    if (paused) {
      esRef.current?.close();
      esRef.current = null;
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
      setConnState("paused");
    } else if (connState === "paused") {
      connectSSE();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  // ── Filter ──────────────────────────────────────────────────────
  const filtered = events.filter((e) => {
    if (filter === "success"   && e.type !== "settlement.success") return false;
    if (filter === "failure"   && e.type !== "execution.failure")  return false;
    if (filter === "rate.limit" && e.type !== "rate.limit")         return false;
    if (agentSearch && !e.agentId.toLowerCase().includes(agentSearch.toLowerCase())) return false;
    return true;
  });

  const typeColor: Record<AuditEvent["type"], string> = {
    "settlement.success": "border-emerald-800 bg-emerald-950/30",
    "execution.failure":  "border-red-800 bg-red-950/30",
    "rate.limit":         "border-amber-800 bg-amber-950/30",
    "key.created":        "border-blue-800 bg-blue-950/30",
    "key.revoked":        "border-zinc-700 bg-zinc-900",
  };

  const labelColor: Record<AuditEvent["type"], string> = {
    "settlement.success": "text-emerald-400",
    "execution.failure":  "text-red-400",
    "rate.limit":         "text-amber-400",
    "key.created":        "text-blue-400",
    "key.revoked":        "text-zinc-400",
  };

  const connBadge: Record<ConnectionState, { label: string; cls: string }> = {
    connecting: { label: "CONNECTING",  cls: "text-zinc-400 animate-pulse" },
    live:       { label: "LIVE SSE",    cls: "text-emerald-400" },
    polling:    { label: "POLLING",     cls: "text-amber-400" },
    paused:     { label: "PAUSED",      cls: "text-zinc-500" },
    mock:       { label: "MOCK",        cls: "text-zinc-600" },
  };

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex rounded-md border border-zinc-700 overflow-hidden">
          {(
            [
              ["all",        "All"],
              ["success",    "Success"],
              ["failure",    "Failure"],
              ["rate.limit", "Rate Limit"],
            ] as [FilterType, string][]
          ).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilter(val)}
              className={`px-3 py-1.5 text-sm ${
                filter === val
                  ? "bg-zinc-700 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search agent ID..."
          value={agentSearch}
          onChange={(e) => setAgentSearch(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-zinc-500 w-48"
        />

        <button
          onClick={() => setPaused(!paused)}
          className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
            paused
              ? "border-emerald-700 text-emerald-400 hover:bg-emerald-900/30"
              : "border-amber-700 text-amber-400 hover:bg-amber-900/30"
          }`}
        >
          {paused ? "Resume" : "Pause"}
        </button>

        <span className={`text-xs ml-auto font-mono ${connBadge[connState].cls}`}>
          ● {connBadge[connState].label} &mdash; {filtered.length} events
        </span>
      </div>

      {/* Event Feed */}
      <div className="space-y-2">
        {filtered.map((e) => (
          <div
            key={e.id}
            className={`border rounded-lg p-4 font-mono text-sm transition-all ${typeColor[e.type]}`}
          >
            <div className="flex items-center justify-between">
              <span className={labelColor[e.type]}>{e.type}</span>
              <span className="text-zinc-500 text-xs">
                {new Date(e.time).toLocaleTimeString()}
              </span>
            </div>
            <p className="text-zinc-400 mt-1">Agent: {e.agentId}</p>
            <p className="text-zinc-500 text-xs mt-1">{e.detail}</p>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-zinc-500 text-center py-8">No events match filters</p>
        )}
      </div>
    </div>
  );
}
