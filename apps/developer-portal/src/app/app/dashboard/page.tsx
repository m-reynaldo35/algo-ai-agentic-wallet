"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import CreateAgentWizard from "@/components/customer/CreateAgentWizard";

interface AgentInfo {
  agentId: string;
  address?: string;
  authAddr?: string;
  status?: string;
  custody?: "rocca" | "user";
  ownerAddress?: string;
  createdAt?: string;
  platform?: string;
}

interface Session {
  ownerAddress: string;
  agentId?: string;  // legacy
  agents: AgentInfo[];
}

// ── Status helpers ────────────────────────────────────────────────
function statusColor(status?: string): string {
  switch (status) {
    case "active":
    case "registered": return "text-emerald-400";
    case "pending":    return "text-amber-400";
    case "suspended":  return "text-amber-400";
    case "orphaned":   return "text-purple-400";
    default:           return "text-zinc-400";
  }
}

function statusDot(status?: string): string {
  switch (status) {
    case "active":
    case "registered": return "bg-emerald-400";
    case "pending":    return "bg-amber-400 animate-pulse";
    case "suspended":  return "bg-amber-400";
    case "orphaned":   return "bg-purple-400";
    default:           return "bg-zinc-500";
  }
}

function statusLabel(status?: string): string {
  switch (status) {
    case "active":
    case "registered": return status;
    case "pending":    return "awaiting ALGO";
    case "suspended":  return "suspended";
    case "orphaned":   return "orphaned";
    default:           return status ?? "unknown";
  }
}

// ── Dashboard ────────────────────────────────────────────────────

export default function AgentPortfolioDashboard() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading]         = useState(true);
  const [showCreate, setShowCreate]   = useState(false);

  const loadSession = useCallback(() => {
    fetch("/api/customer/session")
      .then(async (res) => {
        if (!res.ok) { router.replace("/app/login"); return null; }
        return res.json() as Promise<Session>;
      })
      .then((sess) => {
        if (!sess) return;
        // Legacy: single-agent session with agentId — redirect to agent detail
        if (sess.agentId && (!sess.agents || sess.agents.length === 0)) {
          router.replace(`/app/dashboard/${sess.agentId}`);
          return;
        }
        // Portfolio: go directly to first active agent
        const active = (sess.agents ?? []).find((a) => a.status !== "pending");
        const first  = active ?? sess.agents?.[0];
        if (first) {
          router.replace(`/app/dashboard/${first.agentId}`);
          return;
        }
        setSession(sess);
        setLoading(false);
      })
      .catch(() => router.replace("/app/login"));
  }, [router]);

  useEffect(() => { loadSession(); }, [loadSession]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) return null;

  const ownerShort = session.ownerAddress
    ? session.ownerAddress.startsWith("webauthn:")
      ? `pk-${session.ownerAddress.slice(9, 13).toUpperCase()}-${session.ownerAddress.slice(13, 17).toUpperCase()}`
      : `${session.ownerAddress.slice(0, 6)}…${session.ownerAddress.slice(-4)}`
    : "";

  return (
    <div className="max-w-4xl mx-auto px-6 sm:px-8 py-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-semibold text-white">My Agents</h1>
          <p className="text-xs text-zinc-500 mt-0.5 font-mono">{ownerShort}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Agent
        </button>
      </div>

      {/* Agent list */}
      {session.agents.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-zinc-800 rounded-xl">
          <p className="text-zinc-500 text-sm mb-4">No agents yet.</p>
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create your first agent
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {session.agents.map((agent) => {
            const isPending = agent.status === "pending";
            const inner = (
              <>
                {/* Status dot */}
                <div className={`w-2 h-2 rounded-full shrink-0 ${statusDot(agent.status)}`} />

                {/* Agent ID + platform */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-sm text-white truncate ${!isPending ? "group-hover:text-emerald-300 transition-colors" : ""}`}>
                      {agent.agentId}
                    </span>
                    {agent.platform && (
                      <span className="text-xs text-zinc-600 shrink-0">{agent.platform}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className={`text-xs ${statusColor(agent.status)}`}>
                      {statusLabel(agent.status)}
                    </span>
                    {agent.address && (
                      <span className="text-xs text-zinc-600 font-mono">
                        {agent.address.slice(0, 8)}…{agent.address.slice(-6)}
                      </span>
                    )}
                    {agent.createdAt && (
                      <span className="text-xs text-zinc-700">
                        {new Date(agent.createdAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>

                {/* Arrow or pending hint */}
                {isPending
                  ? <span className="text-xs text-zinc-600 shrink-0">send 0.5 ALGO →</span>
                  : <svg className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 shrink-0 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                }
              </>
            );

            return isPending ? (
              <div
                key={agent.agentId}
                className="flex items-center gap-4 bg-zinc-900 border border-amber-900/40 rounded-xl px-5 py-4"
              >
                {inner}
              </div>
            ) : (
              <Link
                key={agent.agentId}
                href={`/app/dashboard/${agent.agentId}`}
                className="flex items-center gap-4 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl px-5 py-4 transition-colors group"
              >
                {inner}
              </Link>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateAgentWizard
          ownerAddress={session.ownerAddress}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadSession(); }}
        />
      )}
    </div>
  );
}
