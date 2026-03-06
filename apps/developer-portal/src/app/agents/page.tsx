"use client";

import { useEffect, useState, useCallback } from "react";

interface Agent {
  agentId:      string;
  address:      string;
  status:       string;
  cohort?:      string;
  createdAt?:   string;
  registeredAt?: string;
}

function truncateAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "active")
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-900/40 text-emerald-400">active</span>;
  if (s === "suspended")
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-900/40 text-red-400">suspended</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-400">{status}</span>;
}

export default function AgentsPage() {
  const [agents,    setAgents]    = useState<Agent[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState("");
  const [search,    setSearch]    = useState("");
  const [filter,    setFilter]    = useState<"all" | "active" | "suspended">("all");
  const [working,   setWorking]   = useState<string | null>(null); // agentId currently being acted on
  const [actionErr, setActionErr] = useState("");

  const loadAgents = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/agents?limit=500");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { agents?: Agent[] } | Agent[];
      const list = Array.isArray(data) ? data : (data.agents ?? []);
      setAgents(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  async function toggleSuspend(agent: Agent) {
    const action = agent.status === "suspended" ? "unsuspend" : "suspend";
    setWorking(agent.agentId);
    setActionErr("");
    try {
      const res = await fetch(`/api/agents/${agent.agentId}/${action}`, { method: "PATCH" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      await loadAgents();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  }

  const displayed = agents.filter((a) => {
    if (filter !== "all" && a.status.toLowerCase() !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return a.agentId.toLowerCase().includes(q) || a.address.toLowerCase().includes(q);
    }
    return true;
  });

  const activeCount    = agents.filter((a) => a.status === "active").length;
  const suspendedCount = agents.filter((a) => a.status === "suspended").length;

  return (
    <div className="max-w-7xl mx-auto px-6 py-10 space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Agent Management</h1>
        <p className="text-zinc-500 text-sm mt-0.5">All registered agents. Suspend or unsuspend individual agents.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total",     value: agents.length,   color: "text-white" },
          { label: "Active",    value: activeCount,     color: "text-emerald-400" },
          { label: "Suspended", value: suspendedCount,  color: "text-red-400" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
            <p className="text-xs text-zinc-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 p-1 bg-zinc-900 border border-zinc-800 rounded-lg">
          {(["all", "active", "suspended"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded text-sm font-medium capitalize transition-colors ${
                filter === f ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex-1 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by agent ID or address…"
            className="w-full pl-10 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
        </div>
      </div>

      {actionErr && (
        <p className="text-red-400 text-sm rounded bg-red-950/40 border border-red-800 px-3 py-2">{actionErr}</p>
      )}

      {/* Table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 flex justify-center">
            <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
          </div>
        ) : error ? (
          <p className="p-6 text-red-400 text-sm">{error}</p>
        ) : displayed.length === 0 ? (
          <p className="p-10 text-center text-zinc-500 text-sm">No agents found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
                  <th className="text-left py-3 px-4">Agent ID</th>
                  <th className="text-left py-3 px-4">Address</th>
                  <th className="text-left py-3 px-4">Status</th>
                  <th className="text-left py-3 px-4">Cohort</th>
                  <th className="text-left py-3 px-4">Registered</th>
                  <th className="py-3 px-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {displayed.map((agent) => (
                  <tr key={agent.agentId} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="py-3 px-4 font-mono text-zinc-200 text-xs whitespace-nowrap">{agent.agentId}</td>
                    <td className="py-3 px-4 font-mono text-zinc-400 text-xs whitespace-nowrap">{truncateAddr(agent.address)}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{statusBadge(agent.status)}</td>
                    <td className="py-3 px-4 text-zinc-500 text-xs whitespace-nowrap">{agent.cohort ?? "—"}</td>
                    <td className="py-3 px-4 text-zinc-500 text-xs whitespace-nowrap">{formatDate(agent.createdAt ?? agent.registeredAt)}</td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <button
                        disabled={working === agent.agentId}
                        onClick={() => toggleSuspend(agent)}
                        className={`px-3 py-1 text-xs rounded font-medium transition-colors disabled:opacity-50 ${
                          agent.status === "suspended"
                            ? "bg-emerald-900/40 text-emerald-400 hover:bg-emerald-900/70 border border-emerald-800"
                            : "bg-red-900/40 text-red-400 hover:bg-red-900/70 border border-red-800"
                        }`}
                      >
                        {working === agent.agentId ? "…" : agent.status === "suspended" ? "Unsuspend" : "Suspend"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-zinc-600">Showing {displayed.length} of {agents.length} agents</p>
    </div>
  );
}
