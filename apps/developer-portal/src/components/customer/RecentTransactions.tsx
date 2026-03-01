"use client";

import { useEffect, useState } from "react";

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
}

interface Props {
  agentId: string;
}

const NETWORK = process.env.NEXT_PUBLIC_ALGORAND_NETWORK || "testnet";
const EXPLORER_BASE =
  NETWORK === "mainnet"
    ? "https://explorer.perawallet.app/tx"
    : "https://testnet.explorer.perawallet.app/tx";

function formatUsdc(val: string | number | undefined): string {
  if (val === undefined || val === null) return "—";
  return `$${(Number(val) / 1_000_000).toFixed(2)}`;
}

function truncateAddr(addr: string): string {
  if (!addr || addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function RecentTransactions({ agentId }: Props) {
  const [rows, setRows] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    fetch(`/api/agents/${agentId}/settlements?limit=20`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as
          | Settlement[]
          | { settlements?: Settlement[]; data?: Settlement[] };
        if (Array.isArray(data)) setRows(data);
        else setRows((data as { settlements?: Settlement[] }).settlements ?? (data as { data?: Settlement[] }).data ?? []);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }, [agentId]);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <h2 className="text-xs text-zinc-500 uppercase tracking-wider mb-4">
        Recent Transactions
      </h2>

      {loading ? (
        <div className="animate-pulse space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-3 bg-zinc-800 rounded" />
          ))}
        </div>
      ) : error ? (
        <p className="text-red-400 text-sm">{error}</p>
      ) : rows.length === 0 ? (
        <p className="text-zinc-500 text-sm">No transactions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
                <th className="text-left py-2 px-3">Time</th>
                <th className="text-left py-2 px-3">Recipient</th>
                <th className="text-right py-2 px-3">USDC</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="py-2 px-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.map((row, i) => {
                const txId = row.txId || row.txnId;
                const recipient = row.recipient || row.recipientAddress || "—";
                const amount = row.amountMicroUsdc || row.amount;
                const timestamp = row.createdAt || row.timestamp;
                const status = row.status || "settled";
                const isOk = status === "settled" || status === "confirmed" || status === "success";

                return (
                  <tr
                    key={txId || i}
                    className="hover:bg-zinc-800/30 transition-colors"
                  >
                    <td className="py-2.5 px-3 text-zinc-400 whitespace-nowrap text-xs">
                      {formatTime(timestamp)}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-zinc-300 whitespace-nowrap text-xs">
                      {truncateAddr(recipient)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-zinc-200 whitespace-nowrap tabular-nums">
                      {formatUsdc(amount)}
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          isOk
                            ? "bg-emerald-900/40 text-emerald-400"
                            : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      {txId && (
                        <a
                          href={`${EXPLORER_BASE}/${txId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-zinc-500 hover:text-emerald-400 transition-colors"
                          title="View on explorer"
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
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
  );
}
