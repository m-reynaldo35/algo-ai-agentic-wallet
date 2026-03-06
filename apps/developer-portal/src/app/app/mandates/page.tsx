"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import MandateTable, { type MandateRecord } from "@/components/mandates/MandateTable";
import MandateCreateModal from "@/components/mandates/MandateCreateModal";
import MandateRevokeModal from "@/components/mandates/MandateRevokeModal";

interface Session {
  agentId: string;
  ownerAddress: string;
}

export default function CustomerMandatesPage() {
  const router = useRouter();
  const [session,       setSession]       = useState<Session | null>(null);
  const [mandates,      setMandates]      = useState<MandateRecord[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState("");
  const [showCreate,    setShowCreate]    = useState(false);
  const [revokeTarget,  setRevokeTarget]  = useState<MandateRecord | null>(null);
  const [filter,        setFilter]        = useState<"all" | "active" | "revoked">("active");

  // Load session
  useEffect(() => {
    fetch("/api/customer/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Session | null) => {
        if (!data) { router.replace("/app/login"); return; }
        setSession(data);
      })
      .catch(() => router.replace("/app/login"));
  }, [router]);

  const loadMandates = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/${session.agentId}/mandates`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as MandateRecord[] | { mandates?: MandateRecord[] };
      setMandates(Array.isArray(data) ? data : (data.mandates ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mandates");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { loadMandates(); }, [loadMandates]);

  const displayed = mandates.filter((m) =>
    filter === "all" ? true : m.status === filter,
  );

  const activeCount  = mandates.filter((m) => m.status === "active").length;
  const revokedCount = mandates.filter((m) => m.status === "revoked").length;

  if (!session) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-white font-semibold text-lg">Mandates</h1>
          <p className="text-zinc-500 text-sm mt-0.5">
            Authorise and manage your agent&apos;s spending limits. Every change requires wallet or passkey verification.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-md transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Mandate
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Active",  value: activeCount,           color: "text-emerald-400" },
          { label: "Revoked", value: revokedCount,          color: "text-zinc-400" },
          { label: "Total",   value: mandates.length,       color: "text-white" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
            <p className="text-xs text-zinc-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Security note */}
      <div className="flex items-start gap-3 bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3">
        <svg className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
          />
        </svg>
        <p className="text-zinc-400 text-xs leading-relaxed">
          Creating or revoking a mandate requires a fresh verification — either scan a QR code with your Algorand wallet (Pera / Defly) or use your device passkey (Touch ID / Face ID / YubiKey). Your session alone is not sufficient.
        </p>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 p-1 bg-zinc-900 border border-zinc-800 rounded-lg w-fit">
        {(["active", "revoked", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded text-sm font-medium capitalize transition-colors ${
              filter === f
                ? "bg-zinc-700 text-white"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            {f}
          </button>
        ))}
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
          <div className="p-10 text-center">
            <p className="text-zinc-500 text-sm mb-3">
              {filter === "active" ? "No active mandates." : "No mandates found."}
            </p>
            {filter === "active" && (
              <button
                onClick={() => setShowCreate(true)}
                className="text-emerald-400 hover:text-emerald-300 text-sm underline transition-colors"
              >
                Create your first mandate →
              </button>
            )}
          </div>
        ) : (
          <MandateTable
            mandates={displayed}
            onRevoke={(m) => setRevokeTarget(m)}
          />
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <MandateCreateModal
          agentId={session.agentId}
          ownerWalletId={session.ownerAddress}
          onCreated={() => { setShowCreate(false); loadMandates(); }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {/* Revoke modal */}
      {revokeTarget && (
        <MandateRevokeModal
          agentId={session.agentId}
          mandate={revokeTarget}
          onRevoked={() => { setRevokeTarget(null); loadMandates(); }}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}
