"use client";

import { useEffect, useState, useCallback } from "react";
import MandateCreateModal from "@/components/mandates/MandateCreateModal";
import MandateRevokeModal from "@/components/mandates/MandateRevokeModal";
import type { MandateRecord } from "@/components/mandates/MandateTable";

interface Props {
  agentId: string;
  ownerAddress: string;
}

function microUsdcToUsdc(val: string | number | undefined): string {
  if (val === undefined || val === null) return "—";
  return `$${(Number(val) / 1_000_000).toFixed(2)}`;
}

function formatExpiry(expiresAt?: number | string | null): string {
  if (!expiresAt) return "No expiry";
  const ts = typeof expiresAt === "string" ? new Date(expiresAt).getTime() : expiresAt;
  const diff = ts - Date.now();
  if (diff <= 0) return "Expired";
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `Expires in ${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours > 0) return `Expires in ${hours}h`;
  const mins = Math.floor(diff / 60_000);
  return `Expires in ${mins}m`;
}

export default function MandateUsageCard({ agentId, ownerAddress }: Props) {
  const [mandates, setMandates]       = useState<MandateRecord[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState("");
  const [showCreate, setShowCreate]   = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<MandateRecord | null>(null);

  const loadMandates = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/${agentId}/mandates`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { mandates?: MandateRecord[] } | MandateRecord[];
      const list = Array.isArray(data)
        ? data
        : (data as { mandates?: MandateRecord[] }).mandates ?? [];
      setMandates(list.filter((m) => m.status === "active"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mandates");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { loadMandates(); }, [loadMandates]);

  return (
    <>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs text-zinc-500 uppercase tracking-wider">Active Mandates</h2>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Mandate
          </button>
        </div>

        {/* Body */}
        {loading ? (
          <div className="animate-pulse space-y-2">
            <div className="h-3 bg-zinc-800 rounded w-3/4" />
            <div className="h-3 bg-zinc-800 rounded w-1/2" />
          </div>
        ) : error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : mandates.length === 0 ? (
          <p className="text-zinc-500 text-sm">
            No active mandates.{" "}
            <button
              onClick={() => setShowCreate(true)}
              className="text-emerald-400 hover:text-emerald-300 underline transition-colors"
            >
              Create one
            </button>{" "}
            to authorise spending.
          </p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {mandates.map((m) => (
              <div
                key={m.mandateId}
                className="bg-zinc-800/50 border border-zinc-700/60 rounded-md px-3 py-2.5"
              >
                {/* ID + revoke */}
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs text-zinc-400">
                    {m.mandateId.slice(0, 12)}…
                  </span>
                  <button
                    onClick={() => setRevokeTarget(m)}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Revoke
                  </button>
                </div>

                {/* Spending caps */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {m.maxPerTx !== undefined && m.maxPerTx !== null && (
                    <span className="px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-300 text-xs">
                      Per-tx {microUsdcToUsdc(m.maxPerTx)}
                    </span>
                  )}
                  {m.maxPer10Min !== undefined && m.maxPer10Min !== null && (
                    <span className="px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-300 text-xs">
                      Per-10min {microUsdcToUsdc(m.maxPer10Min)}
                    </span>
                  )}
                  {m.maxPerDay !== undefined && m.maxPerDay !== null && (
                    <span className="px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-300 text-xs">
                      Per-day {microUsdcToUsdc(m.maxPerDay)}
                    </span>
                  )}
                  {m.maxPerTx === undefined && m.maxPer10Min === undefined && m.maxPerDay === undefined && (
                    <span className="text-xs text-zinc-500">No spending caps set</span>
                  )}
                </div>

                {/* Expiry + recipients */}
                <div className="flex items-center gap-3 text-xs text-zinc-500">
                  <span>{formatExpiry(m.expiresAt)}</span>
                  {m.allowedRecipients && m.allowedRecipients.length > 0 && (
                    <span>{m.allowedRecipients.length} allowed recipient{m.allowedRecipients.length !== 1 ? "s" : ""}</span>
                  )}
                  {m.recurring && (
                    <span className="text-emerald-500/70">Recurring {microUsdcToUsdc(m.recurring.amount)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <MandateCreateModal
          agentId={agentId}
          ownerWalletId={ownerAddress}
          onCreated={() => { setShowCreate(false); loadMandates(); }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {revokeTarget && (
        <MandateRevokeModal
          agentId={agentId}
          mandate={revokeTarget}
          onRevoked={() => { setRevokeTarget(null); loadMandates(); }}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </>
  );
}
