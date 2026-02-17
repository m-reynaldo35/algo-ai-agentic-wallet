"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { MOCK_EVENTS, type AuditEvent } from "@/lib/mock-data";

const agentIds = [
  "sdk-WYQ24WWZ", "sdk-GOBIB6Q4", "sdk-T8XM3PLR", "sdk-KJN9V2AE",
  "sdk-Q7YPFH1B", "sdk-LZWD4C6N", "agent-rogue-01", "agent-rogue-02",
];

const eventTypes: AuditEvent["type"][] = [
  "settlement.success", "execution.failure", "rate.limit", "key.created", "key.revoked",
];

const detailsByType: Record<AuditEvent["type"], string[]> = {
  "settlement.success": ["Toll settled on-chain", "Atomic group confirmed", "USDC transfer verified"],
  "execution.failure": ["Signature Replay Detected", "Invalid nonce", "Rate limit exceeded"],
  "rate.limit": ["Sliding window threshold hit", "IP blocked for 60s", "Burst limit exceeded"],
  "key.created": ["New API key generated", "Platform registered"],
  "key.revoked": ["API key revoked by admin", "Key expired"],
};

type FilterType = "all" | "success" | "failure";

export default function EventLog() {
  const [events, setEvents] = useState<AuditEvent[]>(MOCK_EVENTS);
  const [filter, setFilter] = useState<FilterType>("all");
  const [agentSearch, setAgentSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const counterRef = useRef(MOCK_EVENTS.length);

  const addEvent = useCallback(() => {
    const type = eventTypes[Math.floor(Math.random() * eventTypes.length)];
    const details = detailsByType[type];
    const evt: AuditEvent = {
      id: `evt-live-${++counterRef.current}`,
      time: new Date().toISOString(),
      type,
      agentId: agentIds[Math.floor(Math.random() * agentIds.length)],
      detail: details[Math.floor(Math.random() * details.length)],
    };
    setEvents((prev) => [evt, ...prev].slice(0, 100));
  }, []);

  useEffect(() => {
    if (paused) return;
    const interval = setInterval(addEvent, 4000);
    return () => clearInterval(interval);
  }, [paused, addEvent]);

  const filtered = events.filter((e) => {
    if (filter === "success" && e.type !== "settlement.success") return false;
    if (filter === "failure" && e.type !== "execution.failure") return false;
    if (agentSearch && !e.agentId.toLowerCase().includes(agentSearch.toLowerCase())) return false;
    return true;
  });

  const typeColor: Record<AuditEvent["type"], string> = {
    "settlement.success": "border-emerald-800 bg-emerald-950/30",
    "execution.failure": "border-red-800 bg-red-950/30",
    "rate.limit": "border-amber-800 bg-amber-950/30",
    "key.created": "border-blue-800 bg-blue-950/30",
    "key.revoked": "border-zinc-700 bg-zinc-900",
  };

  const labelColor: Record<AuditEvent["type"], string> = {
    "settlement.success": "text-emerald-400",
    "execution.failure": "text-red-400",
    "rate.limit": "text-amber-400",
    "key.created": "text-blue-400",
    "key.revoked": "text-zinc-400",
  };

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex rounded-md border border-zinc-700 overflow-hidden">
          {([["all", "All"], ["success", "Success"], ["failure", "Failure"]] as [FilterType, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilter(val)}
              className={`px-3 py-1.5 text-sm ${
                filter === val ? "bg-zinc-700 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"
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

        <span className="text-xs text-zinc-500 ml-auto">
          {filtered.length} events {!paused && <span className="text-emerald-400">LIVE</span>}
        </span>
      </div>

      {/* Event Feed */}
      <div className="space-y-2">
        {filtered.map((e) => (
          <div key={e.id} className={`border rounded-lg p-4 font-mono text-sm ${typeColor[e.type]}`}>
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
