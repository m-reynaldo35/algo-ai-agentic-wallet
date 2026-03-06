"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

const NETWORK      = process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet";
const EXPLORER_BASE =
  NETWORK === "mainnet"
    ? "https://explorer.perawallet.app/tx"
    : "https://testnet.explorer.perawallet.app/tx";

const PAGE_SIZE = 25;

interface Settlement {
  txId?: string;
  txnId?: string;
  createdAt?: string;
  timestamp?: string;
  recipient?: string;
  recipientAddress?: string;
  amountMicroUsdc?: string | number;
  amount?: string | number;
  status?: string;
  jobId?: string;
}

function formatUsdc(val: string | number | undefined): string {
  if (val === undefined || val === null) return "—";
  return `$${(Number(val) / 1_000_000).toFixed(2)}`;
}

function truncateAddr(addr: string | undefined): string {
  if (!addr) return "—";
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function statusStyle(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "settled" || s === "confirmed" || s === "success")
    return "bg-emerald-900/40 text-emerald-400";
  if (s === "failed" || s === "error")
    return "bg-red-900/40 text-red-400";
  return "bg-zinc-800 text-zinc-400";
}

export default function CustomerHistoryPage() {
  const router = useRouter();
  const [agentId,    setAgentId]    = useState<string>("");
  const [rows,       setRows]       = useState<Settlement[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState("");
  const [page,       setPage]       = useState(0);
  const [hasMore,    setHasMore]    = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "settled" | "failed">("all");
  const [search,     setSearch]     = useState("");

  // Load session
  useEffect(() => {
    fetch("/api/customer/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { agentId?: string } | null) => {
        if (!data?.agentId) { router.replace("/app/login"); return; }
        setAgentId(data.agentId);
      })
      .catch(() => router.replace("/app/login"));
  }, [router]);

  const loadPage = useCallback(async (pageNum: number) => {
    if (!agentId) return;
    setLoading(true);
    setError("");
    try {
      const limit  = PAGE_SIZE + 1; // fetch one extra to detect hasMore
      const offset = pageNum * PAGE_SIZE;
      const res = await fetch(
        `/api/agents/${agentId}/settlements?limit=${limit}&offset=${offset}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as
        | Settlement[]
        | { settlements?: Settlement[]; data?: Settlement[] };
      const list = Array.isArray(data)
        ? data
        : (data as { settlements?: Settlement[] }).settlements
          ?? (data as { data?: Settlement[] }).data
          ?? [];
      setHasMore(list.length > PAGE_SIZE);
      setRows(list.slice(0, PAGE_SIZE));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { loadPage(page); }, [agentId, page, loadPage]);

  // Client-side filter + search
  const displayed = rows.filter((r) => {
    const s = (r.status ?? "settled").toLowerCase();
    const isSettled = s === "settled" || s === "confirmed" || s === "success";
    if (statusFilter === "settled" && !isSettled) return false;
    if (statusFilter === "failed"  && isSettled)  return false;
    if (search) {
      const q = search.toLowerCase();
      const txId = (r.txId || r.txnId || "").toLowerCase();
      const addr = (r.recipient || r.recipientAddress || "").toLowerCase();
      if (!txId.includes(q) && !addr.includes(q)) return false;
    }
    return true;
  });

  if (!agentId) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-white font-semibold text-lg">Transaction History</h1>
        <p className="text-zinc-500 text-sm mt-0.5">All x402 payments made by your agent, with on-chain verification links.</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Status filter */}
        <div className="flex gap-1 p-1 bg-zinc-900 border border-zinc-800 rounded-lg">
          {(["all", "settled", "failed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => { setStatusFilter(f); setPage(0); }}
              className={`px-3 py-1.5 rounded text-sm font-medium capitalize transition-colors ${
                statusFilter === f
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search by tx ID or address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 flex justify-center">
            <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
          </div>
        ) : error ? (
          <p className="p-6 text-red-400 text-sm">{error}</p>
        ) : displayed.length === 0 ? (
          <p className="p-10 text-center text-zinc-500 text-sm">No transactions found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
                  <th className="text-left py-3 px-4">Time</th>
                  <th className="text-left py-3 px-4">Recipient</th>
                  <th className="text-right py-3 px-4">USDC</th>
                  <th className="text-left py-3 px-4">Status</th>
                  <th className="text-left py-3 px-4">Tx ID</th>
                  <th className="py-3 px-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {displayed.map((row, i) => {
                  const txId      = row.txId || row.txnId;
                  const recipient = row.recipient || row.recipientAddress;
                  const amount    = row.amountMicroUsdc || row.amount;
                  const timestamp = row.createdAt || row.timestamp;
                  const status    = row.status || "settled";

                  return (
                    <tr key={txId || row.jobId || i} className="hover:bg-zinc-800/30 transition-colors">
                      <td className="py-3 px-4 text-zinc-400 whitespace-nowrap text-xs">
                        {formatTime(timestamp)}
                      </td>
                      <td className="py-3 px-4 font-mono text-zinc-300 whitespace-nowrap text-xs">
                        {truncateAddr(recipient)}
                      </td>
                      <td className="py-3 px-4 text-right text-zinc-200 whitespace-nowrap tabular-nums font-medium">
                        {formatUsdc(amount)}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusStyle(status)}`}>
                          {status}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-zinc-500 text-xs whitespace-nowrap">
                        {txId ? `${txId.slice(0, 10)}…` : "—"}
                      </td>
                      <td className="py-3 px-4">
                        {txId && (
                          <a
                            href={`${EXPLORER_BASE}/${txId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-zinc-500 hover:text-emerald-400 transition-colors"
                            title="View on Pera Explorer"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                              />
                            </svg>
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {!loading && !error && (
        <div className="flex items-center justify-between text-sm text-zinc-500">
          <span>Page {page + 1}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-md hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-zinc-300"
            >
              ← Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasMore}
              className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-md hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-zinc-300"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
