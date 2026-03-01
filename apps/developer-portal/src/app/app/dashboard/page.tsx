"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AgentStatusCard from "@/components/customer/AgentStatusCard";
import WalletCard from "@/components/customer/WalletCard";
import MandateUsageCard from "@/components/customer/MandateUsageCard";
import RecentTransactions from "@/components/customer/RecentTransactions";

interface Session {
  agentId: string;
  ownerAddress: string;
}

interface AgentInfo {
  agentId: string;
  status?: string;
  halted?: boolean;
  cohort?: string;
  registeredAt?: string;
  createdAt?: string;
  signerAddress?: string;
  walletAddress?: string;
}

export default function CustomerDashboard() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [agentError, setAgentError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load session first, then agent info in parallel with balance
    fetch("/api/customer/session")
      .then(async (res) => {
        if (!res.ok) {
          // Session expired or missing — redirect to login
          router.replace("/app/login");
          return null;
        }
        return res.json() as Promise<Session>;
      })
      .then((sess) => {
        if (!sess) return;
        setSession(sess);
        setLoading(false);

        // Load agent info
        fetch(`/api/agents/${sess.agentId}`)
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json() as Promise<AgentInfo>;
          })
          .then((data) => setAgent(data))
          .catch((err) =>
            setAgentError(
              err instanceof Error ? err.message : "Failed to load agent",
            ),
          );
      })
      .catch(() => {
        router.replace("/app/login");
      });
  }, [router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) return null;

  // Prefer the signer address from agent info for the wallet card
  const walletAddress =
    agent?.signerAddress || agent?.walletAddress || session.ownerAddress;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      {/* Top row — Agent Status + Wallet */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <AgentStatusCard
          agentId={session.agentId}
          agent={agent}
          error={agentError}
        />
        <WalletCard address={walletAddress} />
      </div>

      {/* Mandates */}
      <MandateUsageCard
        agentId={session.agentId}
        ownerAddress={session.ownerAddress}
      />

      {/* Recent Transactions */}
      <RecentTransactions agentId={session.agentId} />
    </div>
  );
}
