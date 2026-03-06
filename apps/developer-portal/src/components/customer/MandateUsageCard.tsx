"use client";

import { useEffect, useState, useCallback } from "react";
import MandateCreateModal from "@/components/mandates/MandateCreateModal";
import type { MandateRecord } from "@/components/mandates/MandateTable";

interface Props {
  agentId: string;
  ownerAddress: string;
}

function microUsdcToUsdc(val: string | number | undefined): string {
  if (val === undefined || val === null) return "—";
  return `$${(Number(val) / 1_000_000).toFixed(2)}`;
}

function formatExpiry(expiresAt?: string | null): string {
  if (!expiresAt) return "";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `Expires in ${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  return `Expires in ${hours}h`;
}

export default function MandateUsageCard({ agentId, ownerAddress }: Props) {
  const [mandates, setMandates] = useState<MandateRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const loadMandates = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/${agentId}/mandates`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { mandates?: MandateRecord[] } | MandateRecord[];
      setMandates(
        Array.isArray(data)
          ? data
          : (data as { mandates?: MandateRecord[] }).mandates ?? [],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mandates");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadMandates();
  }, [loadMandates]);

  const activeMandates = mandates.filter((m) => m.status === "active");
  const first = activeMandates[0];

  return (
    <>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs text-zinc-500 uppercase tracking-wider">
            Active Mandates
          </h2>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
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
                d="M12 4v16m8-8H4"
              />
            </svg>
            New Mandate
          </button>
        </div>

        {loading ? (
          <div className="animate-pulse space-y-2">
            <div className="h-3 bg-zinc-800 rounded w-3/4" />
            <div className="h-3 bg-zinc-800 rounded w-1/2" />
          </div>
        ) : error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : activeMandates.length === 0 ? (
          <p className="text-zinc-500 text-sm">
            No active mandates.{" "}
            <button
              onClick={() => setShowCreate(true)}
              className="text-emerald-400 hover:text-emerald-300 underline transition-colors"
            >
              Create one
            </button>{" "}
            to authorize spending.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Spending caps pills */}
            {first && (
              <div className="flex flex-wrap gap-2">
                {first.maxPerTxMicroUsdc !== undefined && (
                  <span className="px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-300 text-xs">
                    Per-tx {microUsdcToUsdc(first.maxPerTxMicroUsdc)}
                  </span>
                )}
                {first.maxPer10MinMicroUsdc !== undefined && (
                  <span className="px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-300 text-xs">
                    Per-10min {microUsdcToUsdc(first.maxPer10MinMicroUsdc)}
                  </span>
                )}
                {first.maxPerDayMicroUsdc !== undefined && (
                  <span className="px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-300 text-xs">
                    Per-day {microUsdcToUsdc(first.maxPerDayMicroUsdc)}
                  </span>
                )}
              </div>
            )}

            {/* Expiry + count */}
            <div className="flex items-center justify-between text-xs text-zinc-500">
              {first?.expiresAt ? (
                <span>{formatExpiry(first.expiresAt)}</span>
              ) : (
                <span>{activeMandates.length} active mandate{activeMandates.length !== 1 ? "s" : ""}</span>
              )}
              <a
                href="/app/mandates"
                className="text-emerald-400 hover:text-emerald-300 transition-colors"
              >
                Manage all →
              </a>
            </div>
          </div>
        )}
      </div>

      {showCreate && (
        <MandateCreateModal
          agentId={agentId}
          ownerWalletId={ownerAddress}
          onCreated={() => {
            setShowCreate(false);
            loadMandates();
          }}
          onClose={() => setShowCreate(false)}
        />
      )}
    </>
  );
}
