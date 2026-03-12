"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import AgentStatusCard from "@/components/customer/AgentStatusCard";
import WalletCard from "@/components/customer/WalletCard";
import WalletQRPanel from "@/components/customer/WalletQRPanel";
import MandateUsageCard from "@/components/customer/MandateUsageCard";
import RecentTransactions from "@/components/customer/RecentTransactions";
import CreateAgentWizard from "@/components/customer/CreateAgentWizard";

interface AgentListItem {
  agentId:   string;
  address?:  string;
  status?:   string;
  platform?: string;
  createdAt?: string;
}

interface Session {
  ownerAddress: string;
  agentId?: string;
  agents: AgentListItem[];
}

interface AgentInfo {
  agentId: string;
  address?: string;
  authAddr?: string;
  status?: string;
  halted?: boolean;
  custody?: "rocca" | "user";
  ownerWalletId?: string;
  webauthnPublicKey?: string;
  registeredAt?: string;
  createdAt?: string;
}

// ── Status helpers ─────────────────────────────────────────────────────────

function dot(status?: string) {
  switch (status) {
    case "active":
    case "registered": return "bg-emerald-400";
    case "pending":    return "bg-amber-400 animate-pulse";
    case "suspended":  return "bg-amber-500";
    case "orphaned":   return "bg-purple-400";
    default:           return "bg-zinc-600";
  }
}

// ── Left sidebar — agents list ─────────────────────────────────────────────

function AgentSidebar({
  agents,
  currentId,
  ownerAddress,
  onNewAgent,
}: {
  agents:       AgentListItem[];
  currentId:    string;
  ownerAddress: string;
  onNewAgent:   () => void;
}) {
  const ownerShort = ownerAddress
    ? `${ownerAddress.slice(0, 6)}…${ownerAddress.slice(-4)}`
    : "";

  return (
    <aside className="hidden lg:flex flex-col w-52 shrink-0 border-r border-zinc-800/70 bg-black">
      {/* Identity header */}
      <div className="px-4 pt-5 pb-3 border-b border-zinc-800/70">
        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-0.5">Identity</p>
        <p className="font-mono text-xs text-zinc-400 truncate">{ownerShort}</p>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto py-2">
        <p className="text-[10px] text-zinc-600 uppercase tracking-widest px-4 py-2">My Agents</p>
        <div className="space-y-px">
          {agents.map((a) => {
            const isActive  = a.agentId === currentId;
            const isPending = a.status === "pending";
            const inner = (
              <div className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg mx-2 transition-colors ${
                isActive
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
              }`}>
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot(a.status)}`} />
                <span className="font-mono text-xs truncate flex-1">{a.agentId}</span>
              </div>
            );
            return isPending ? (
              <div key={a.agentId} className="cursor-default opacity-60">{inner}</div>
            ) : (
              <Link key={a.agentId} href={`/app/dashboard/${a.agentId}`}>{inner}</Link>
            );
          })}

          {agents.length === 0 && (
            <p className="px-4 py-3 text-xs text-zinc-600">No agents yet.</p>
          )}
        </div>
      </div>

      {/* New agent button */}
      <div className="p-3 border-t border-zinc-800/70">
        <button
          onClick={onNewAgent}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors font-medium"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Agent
        </button>
      </div>
    </aside>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function AgentDetailPage() {
  const router  = useRouter();
  const params  = useParams<{ agentId: string }>();
  const agentId = params.agentId;

  const [session, setSession]         = useState<Session | null>(null);
  const [agent, setAgent]             = useState<AgentInfo | null>(null);
  const [agentError, setAgentError]   = useState("");
  const [loading, setLoading]         = useState(true);
  const [showCreate, setShowCreate]   = useState(false);

  const loadSession = useCallback(() => {
    return fetch("/api/customer/session")
      .then(async (res) => {
        if (!res.ok) { router.replace("/app/login"); return; }
        const sess = await res.json() as Session;
        setSession(sess);
        setLoading(false);
      })
      .catch(() => router.replace("/app/login"));
  }, [router]);

  useEffect(() => {
    loadSession().then(() => {
      fetch(`/api/agents/${agentId}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<AgentInfo>;
        })
        .then(setAgent)
        .catch((err) => setAgentError(err instanceof Error ? err.message : "Failed to load agent"));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) return null;

  const rawOwner       = session.ownerAddress ?? "";
  const ownerAlgoAddr  = rawOwner.startsWith("webauthn:") ? "" : rawOwner;
  const walletAddress  = agent?.address || agent?.authAddr || ownerAlgoAddr;

  return (
    <div className="flex min-h-[calc(100vh-94px)]">
      {/* ── Left sidebar ── */}
      <AgentSidebar
        agents={session.agents ?? []}
        currentId={agentId}
        ownerAddress={session.ownerAddress}
        onNewAgent={() => setShowCreate(true)}
      />

      {/* ── Main content ── */}
      <div className="flex flex-1 min-w-0">
        <div className="flex-1 min-w-0 px-6 lg:px-8 py-8 space-y-5">
          {/* Header: agent name + New Agent button */}
          <div className="flex items-center justify-between">
            <h1 className="font-mono text-sm text-zinc-300">{agentId}</h1>
            {/* Mobile-only New Agent — sidebar handles desktop */}
            <button
              onClick={() => setShowCreate(true)}
              className="lg:hidden inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Agent
            </button>
          </div>

          {/* Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <AgentStatusCard agentId={agentId} agent={agent} error={agentError} />
            {walletAddress && <WalletCard address={walletAddress} showQR={false} />}
          </div>

          <MandateUsageCard agentId={agentId} ownerAddress={session.ownerAddress} />
          <RecentTransactions agentId={agentId} />
        </div>

        {/* ── Right QR panel (XL+) ── */}
        {walletAddress && (
          <div className="w-64 shrink-0 hidden xl:block px-4 py-8 sticky top-[94px] self-start">
            <WalletQRPanel address={walletAddress} />
          </div>
        )}
      </div>

      {/* ── Create wizard modal ── */}
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
