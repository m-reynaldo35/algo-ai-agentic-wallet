"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import MandateTable, { type MandateRecord } from "@/components/mandates/MandateTable";
import MandateCreateModal from "@/components/mandates/MandateCreateModal";
import MandateRevokeModal from "@/components/mandates/MandateRevokeModal";

interface AgentSummary {
  agentId:       string;
  status?:       string;
  address?:      string;
  ownerWalletId?: string;
}

interface Session {
  agentId?:     string;
  ownerAddress: string;
  agents?:      AgentSummary[];
}

// ── Agent picker — shown when no ?agent= param and the user has multiple agents ──

function AgentPicker({
  agents,
  onPick,
}: {
  agents:  AgentSummary[];
  onPick:  (agentId: string) => void;
}) {
  return (
    <div className="max-w-md mx-auto px-4 py-16 text-center space-y-6">
      <div>
        <h1 className="text-white font-semibold text-lg">Select an Agent</h1>
        <p className="text-zinc-500 text-sm mt-1">
          Choose which agent wallet you want to manage mandates for.
        </p>
      </div>
      <div className="space-y-2">
        {agents.map((a) => (
          <button
            key={a.agentId}
            onClick={() => onPick(a.agentId)}
            className="w-full flex items-center gap-3 px-4 py-3 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded-lg transition-colors group"
          >
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              a.status === "active" || a.status === "registered"
                ? "bg-emerald-400"
                : a.status === "pending"
                ? "bg-amber-400 animate-pulse"
                : "bg-zinc-600"
            }`} />
            <span className="font-mono text-sm text-zinc-300 group-hover:text-white transition-colors flex-1 text-left">
              {a.agentId}
            </span>
            <svg className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main mandates view ───────────────────────────────────────────────────────

function MandatesContent() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  // agentId from ?agent= query param (set by nav link from dashboard) OR session fallback
  const [agentId,       setAgentId]       = useState(searchParams.get("agent") ?? "");
  const [ownerWalletId, setOwnerWalletId] = useState("");
  const [agentAddress,  setAgentAddress]  = useState("");
  const [mandates,      setMandates]      = useState<MandateRecord[]>([]);
  const [ready,         setReady]         = useState(false);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState("");
  const [showCreate,    setShowCreate]    = useState(false);
  const [revokeTarget,  setRevokeTarget]  = useState<MandateRecord | null>(null);
  const [filter,        setFilter]        = useState<"all" | "active" | "revoked">("active");
  const [pickAgents,    setPickAgents]    = useState<AgentSummary[] | null>(null);

  // Effect 1: resolve agentId from session (runs once on mount)
  useEffect(() => {
    fetch("/api/customer/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Session | null) => {
        if (!data) { router.replace("/app/login"); return; }

        const resolvedAgentId = agentId || data.agentId || "";

        if (!resolvedAgentId) {
          const agents = data.agents ?? [];
          const active = agents.filter((a) => a.status !== "pending");
          if (active.length === 1) { setAgentId(active[0].agentId); return; }
          if (agents.length > 0)   { setPickAgents(agents); return; }
          router.replace("/app/login");
          return;
        }

        if (resolvedAgentId !== agentId) setAgentId(resolvedAgentId);
      })
      .catch(() => router.replace("/app/login"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effect 2: fetch agent record whenever agentId is known — mirrors dashboard pattern
  useEffect(() => {
    if (!agentId) return;
    fetch(`/api/agents/${agentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((agent: { ownerWalletId?: string; address?: string } | null) => {
        if (!agent) return;
        setOwnerWalletId(agent.ownerWalletId ?? "");
        setAgentAddress(agent.address ?? "");
        setReady(true);
      })
      .catch(() => setReady(true));
  }, [agentId]);

  const loadMandates = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/${agentId}/mandates?includeRevoked=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as MandateRecord[] | { mandates?: MandateRecord[] };
      setMandates(Array.isArray(data) ? data : (data.mandates ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mandates");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { if (ready) loadMandates(); }, [ready, loadMandates]);

  const displayed    = mandates.filter((m) => filter === "all" ? true : m.status === filter);
  const activeCount  = mandates.filter((m) => m.status === "active").length;
  const revokedCount = mandates.filter((m) => m.status === "revoked").length;

  // Show agent picker when no specific agent is selected
  if (pickAgents) {
    return (
      <AgentPicker
        agents={pickAgents}
        onPick={(id) => {
          setPickAgents(null);
          setAgentId(id);
        }}
      />
    );
  }

  if (!ready) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-white font-semibold text-lg">Mandates</h1>
          <p className="text-zinc-500 text-sm mt-0.5">
            <span className="font-mono text-zinc-400">{agentId}</span>
            {" · "}authorise and manage spending limits. Every change requires wallet or passkey verification.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {agentId && (
            <Link
              href={`/app/dashboard/${agentId}`}
              className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-sm rounded-md transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Dashboard
            </Link>
          )}
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
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Active",  value: activeCount,     color: "text-emerald-400" },
          { label: "Revoked", value: revokedCount,    color: "text-zinc-400" },
          { label: "Total",   value: mandates.length, color: "text-white" },
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
              filter === f ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
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
          <MandateTable mandates={displayed} onRevoke={(m) => setRevokeTarget(m)} />
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <MandateCreateModal
          agentId={agentId}
          ownerWalletId={ownerWalletId}
          agentAddress={agentAddress}
          onCreated={() => { setShowCreate(false); loadMandates(); }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {/* Revoke modal */}
      {revokeTarget && (
        <MandateRevokeModal
          agentId={agentId}
          mandate={revokeTarget}
          onRevoked={() => { setRevokeTarget(null); loadMandates(); }}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}

export default function CustomerMandatesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <MandatesContent />
    </Suspense>
  );
}
