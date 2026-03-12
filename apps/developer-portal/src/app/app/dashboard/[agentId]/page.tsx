"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import AgentStatusCard from "@/components/customer/AgentStatusCard";
import WalletCard from "@/components/customer/WalletCard";
import WalletQRPanel from "@/components/customer/WalletQRPanel";
import MandateUsageCard from "@/components/customer/MandateUsageCard";
import RecentTransactions from "@/components/customer/RecentTransactions";

interface Session {
  ownerAddress: string;
  agentId?: string;
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

export default function AgentDetailPage() {
  const router = useRouter();
  const params = useParams<{ agentId: string }>();
  const agentId = params.agentId;

  const [session, setSession]     = useState<Session | null>(null);
  const [agent, setAgent]         = useState<AgentInfo | null>(null);
  const [agentError, setAgentError] = useState("");
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    fetch("/api/customer/session")
      .then(async (res) => {
        if (!res.ok) { router.replace("/app/login"); return null; }
        return res.json() as Promise<Session>;
      })
      .then((sess) => {
        if (!sess) return;
        setSession(sess);
        setLoading(false);

        fetch(`/api/agents/${agentId}`)
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json() as Promise<AgentInfo>;
          })
          .then(setAgent)
          .catch((err) => setAgentError(err instanceof Error ? err.message : "Failed to load agent"));
      })
      .catch(() => router.replace("/app/login"));
  }, [agentId, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) return null;

  const rawOwner = session.ownerAddress ?? "";
  const ownerAlgoAddress = rawOwner.startsWith("webauthn:") ? "" : rawOwner;
  const walletAddress = agent?.address || agent?.authAddr || ownerAlgoAddress;

  return (
    <div className="max-w-7xl mx-auto px-6 sm:px-8 py-10">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/app/dashboard" className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <h1 className="text-sm text-zinc-400 font-mono">{agentId}</h1>
        </div>
      </div>

      <div className="flex gap-6 items-start">
        <div className="flex-1 min-w-0 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <AgentStatusCard agentId={agentId} agent={agent} error={agentError} />
            {walletAddress && <WalletCard address={walletAddress} showQR={false} />}
          </div>
          <MandateUsageCard agentId={agentId} ownerAddress={session.ownerAddress} />
          <RecentTransactions agentId={agentId} />
        </div>
        {walletAddress && (
          <div className="w-72 shrink-0 hidden lg:block sticky top-6">
            <WalletQRPanel address={walletAddress} />
          </div>
        )}
      </div>
    </div>
  );
}
