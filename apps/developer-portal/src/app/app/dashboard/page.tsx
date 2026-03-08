"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AgentStatusCard from "@/components/customer/AgentStatusCard";
import WalletCard from "@/components/customer/WalletCard";
import WalletQRPanel from "@/components/customer/WalletQRPanel";
import MandateUsageCard from "@/components/customer/MandateUsageCard";
import RecentTransactions from "@/components/customer/RecentTransactions";

interface Session {
  agentId: string;
  ownerAddress: string;
}

interface AgentInfo {
  agentId: string;
  address?: string;    // permanent on-chain Algorand address
  authAddr?: string;   // Rocca signer / auth-addr
  status?: string;
  halted?: boolean;
  cohort?: string;
  registeredAt?: string;
  createdAt?: string;
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

  // Use the agent's on-chain Algorand address for balance and QR.
  // agent.address is the permanent account address; agent.authAddr is the
  // Rocca signer. Fall back to ownerAddress but strip any "webauthn:" prefix
  // (synthetic ID assigned when no Liquid Auth session existed at registration).
  const rawOwner = session.ownerAddress ?? "";
  const ownerAlgoAddress = rawOwner.startsWith("webauthn:") ? "" : rawOwner;
  const walletAddress = agent?.address || agent?.authAddr || ownerAlgoAddress;

  return (
    <div className="max-w-7xl mx-auto px-6 sm:px-8 py-10">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-sm text-zinc-400">Dashboard</h1>
        <Link
          href="/app/create"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-400 border border-emerald-800 rounded-md transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create Agent
        </Link>
      </div>

      <div className="flex gap-6 items-start">
        {/* Left — main content */}
        <div className="flex-1 min-w-0 space-y-5">
          {/* Agent Status + Wallet (balance only, no QR) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <AgentStatusCard
              agentId={session.agentId}
              agent={agent}
              error={agentError}
            />
            {walletAddress && <WalletCard address={walletAddress} showQR={false} />}
          </div>

          {/* Mandates */}
          <MandateUsageCard
            agentId={session.agentId}
            ownerAddress={session.ownerAddress}
          />

          {/* Recent Transactions */}
          <RecentTransactions agentId={session.agentId} />
        </div>

        {/* Right — QR top-up panel (only when a real Algorand address is known) */}
        {walletAddress && (
          <div className="w-72 shrink-0 hidden lg:block sticky top-6">
            <WalletQRPanel address={walletAddress} />
          </div>
        )}
      </div>
    </div>
  );
}
