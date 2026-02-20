"use client";

import { useState, useMemo, useEffect } from "react";
import { MOCK_SETTLEMENTS, type Settlement } from "@/lib/mock-data";
import SettlementDetailModal from "./SettlementDetailModal";

type DateRange = "24h" | "7d" | "30d";

export default function SettlementTable() {
  const [statusFilter, setStatusFilter] = useState<"all" | "confirmed" | "failed">("all");
  const [agentSearch, setAgentSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>("7d");
  const [selected, setSelected] = useState<Settlement | null>(null);
  const [settlements, setSettlements] = useState<Settlement[]>(MOCK_SETTLEMENTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSettlements() {
      try {
        const params = new URLSearchParams({
          range: dateRange,
          status: statusFilter,
          agent: agentSearch,
          offset: "0",
          limit: "50",
        });
        const res = await fetch(`/api/live/settlements?${params}`);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (data.settlements && data.settlements.length > 0) {
          setSettlements(data.settlements);
        }
      } catch {
        // Keep mock data as fallback for local dev
      } finally {
        setLoading(false);
      }
    }
    fetchSettlements();
  }, [dateRange, statusFilter, agentSearch]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const rangeMs = { "24h": 86400000, "7d": 604800000, "30d": 2592000000 }[dateRange];

    return settlements.filter((s) => {
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (agentSearch && !s.agentId.toLowerCase().includes(agentSearch.toLowerCase())) return false;
      if (now - new Date(s.time).getTime() > rangeMs) return false;
      return true;
    });
  }, [statusFilter, agentSearch, dateRange, settlements]);

  return (
    <>
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-white"
        >
          <option value="all">All Statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="failed">Failed</option>
        </select>

        <input
          type="text"
          placeholder="Search agent ID..."
          value={agentSearch}
          onChange={(e) => setAgentSearch(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-zinc-500 w-48"
        />

        <div className="flex rounded-md border border-zinc-700 overflow-hidden">
          {(["24h", "7d", "30d"] as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setDateRange(r)}
              className={`px-3 py-1.5 text-sm ${
                dateRange === r ? "bg-zinc-700 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <span className="text-xs text-zinc-500 ml-auto">
          {loading ? "Loading..." : `${filtered.length} results`}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-500">
              <th className="pb-3 pr-4 font-medium">Time</th>
              <th className="pb-3 pr-4 font-medium">Agent</th>
              <th className="pb-3 pr-4 font-medium">Status</th>
              <th className="pb-3 pr-4 font-medium">Amount</th>
              <th className="pb-3 pr-4 font-medium">Txn ID</th>
              <th className="pb-3 font-medium">Chain</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr
                key={s.id}
                onClick={() => setSelected(s)}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/50 cursor-pointer transition-colors"
              >
                <td className="py-3 pr-4 text-zinc-400 whitespace-nowrap">
                  {new Date(s.time).toLocaleDateString()} {new Date(s.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="py-3 pr-4 font-mono text-zinc-300">{s.agentId}</td>
                <td className="py-3 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    s.status === "confirmed" ? "bg-emerald-900/50 text-emerald-400" : "bg-red-900/50 text-red-400"
                  }`}>
                    {s.status}
                  </span>
                </td>
                <td className="py-3 pr-4 font-mono">{(s.amountMicroUsdc / 1e6).toFixed(2)}</td>
                <td className="py-3 pr-4 font-mono text-zinc-500 text-xs">{s.txnId}</td>
                <td className="py-3 text-zinc-500">{s.chain}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-zinc-500">No settlements match filters</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && <SettlementDetailModal settlement={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
