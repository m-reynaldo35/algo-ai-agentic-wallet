"use client";

import { useState } from "react";

const NETWORK = process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet";

interface AgentInfo {
  agentId: string;
  address?: string;
  authAddr?: string;
  status?: string;
  halted?: boolean;
  custody?: "rocca" | "user";
  ownerWalletId?: string;
  webauthnPublicKey?: string;
  webauthnCredentialId?: string;
  registeredAt?: string;
  createdAt?: string;
}

interface Props {
  agentId:    string;
  agent:      AgentInfo | null;
  error?:     string;
  onRegister?: () => void;
}

type StatusKind = "active" | "halted" | "suspended" | "orphaned" | "registered" | "unknown";

function resolveStatus(agent: AgentInfo): StatusKind {
  if (agent.halted || agent.status === "halted") return "halted";
  const s = agent.status?.toLowerCase() ?? "";
  if (s === "suspended") return "suspended";
  if (s === "orphaned")  return "orphaned";
  if (s === "registered") return "registered";
  if (s === "active" || s === "") return "active";
  return "unknown";
}

const STATUS_STYLES: Record<StatusKind, { pill: string; dot: string; label: string; desc: string }> = {
  active:     { pill: "bg-emerald-900/40 text-emerald-400 border-emerald-800", dot: "bg-emerald-400", label: "Active",     desc: "Processing payments normally" },
  registered: { pill: "bg-emerald-900/40 text-emerald-400 border-emerald-800", dot: "bg-emerald-400", label: "Registered", desc: "Ready to process payments" },
  halted:     { pill: "bg-red-900/40 text-red-400 border-red-800",             dot: "bg-red-400",     label: "Halted",     desc: "Payments blocked — security alert" },
  suspended:  { pill: "bg-amber-900/40 text-amber-400 border-amber-800",       dot: "bg-amber-400",   label: "Suspended",  desc: "Temporarily paused" },
  orphaned:   { pill: "bg-purple-900/40 text-purple-400 border-purple-800",    dot: "bg-purple-400",  label: "Orphaned",   desc: "No active signing key" },
  unknown:    { pill: "bg-zinc-800 text-zinc-400 border-zinc-700",             dot: "bg-zinc-400",    label: "Unknown",    desc: "" },
};

function CheckIcon({ ok }: { ok: boolean }) {
  if (ok) {
    return (
      <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  return (
    <svg className="w-3.5 h-3.5 text-zinc-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export default function AgentStatusCard({ agentId, agent, error, onRegister }: Props) {
  const [copied, setCopied] = useState(false);

  function copyId() {
    navigator.clipboard.writeText(agentId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const statusKind: StatusKind = agent ? resolveStatus(agent) : "unknown";
  const style = STATUS_STYLES[statusKind];
  const registeredDate = agent?.registeredAt || agent?.createdAt;

  // Auth method derivation
  const hasLiquidAuth  = !!agent?.ownerWalletId && !agent.ownerWalletId.startsWith("webauthn:");
  const hasPasskey     = !!agent?.webauthnCredentialId;
  const hasAnyAuth     = hasLiquidAuth || hasPasskey;

  // Custody label
  const custodyLabel = agent?.custody === "user"
    ? "Self-custody"
    : "Server-managed";
  const custodyDesc  = agent?.custody === "user"
    ? "You hold the signing key"
    : "Rocca signs on your behalf";

  const networkLabel = NETWORK === "mainnet" ? "Mainnet" : "Testnet";
  const networkStyle = NETWORK === "mainnet"
    ? "bg-emerald-900/30 text-emerald-400 border-emerald-800"
    : "bg-amber-900/30 text-amber-400 border-amber-800";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs text-zinc-500 uppercase tracking-wider">Agent Status</h2>
        {/* Network badge */}
        <span className={`text-xs px-2 py-0.5 rounded border font-medium ${networkStyle}`}>
          {networkLabel}
        </span>
      </div>

      {error ? (
        <p className="text-red-400 text-sm">{error}</p>
      ) : (
        <div className="space-y-4">
          {/* Agent ID */}
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Agent ID</label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-zinc-200 text-xs break-all flex-1">{agentId}</span>
              <button
                onClick={copyId}
                title="Copy agent ID"
                className="shrink-0 text-zinc-500 hover:text-emerald-400 transition-colors"
              >
                {copied ? (
                  <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Status badge */}
          {agent && (
            <div>
              <label className="block text-xs text-zinc-600 mb-1">Status</label>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${style.pill}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                  {style.label}
                </span>
                {style.desc && (
                  <span className="text-xs text-zinc-500">{style.desc}</span>
                )}
              </div>
            </div>
          )}

          {/* Auth methods */}
          {agent && (
            <div>
              <label className="block text-xs text-zinc-600 mb-2">Auth Methods</label>
              <div className="space-y-1.5">
                {/* Algorand Wallet row */}
                <div className="flex items-center gap-2 min-w-0">
                  <CheckIcon ok={hasLiquidAuth} />
                  <span className={`text-xs truncate ${hasLiquidAuth ? "text-zinc-300" : "text-zinc-600"}`}>
                    Algorand Wallet (Pera / Defly QR)
                  </span>
                </div>
                {/* Device Passkey row */}
                <div className="flex items-center gap-2 min-w-0">
                  <CheckIcon ok={hasPasskey} />
                  <span className={`text-xs truncate ${hasPasskey ? "text-zinc-300" : "text-zinc-600"}`}>
                    Device Passkey (Touch ID / Face ID / YubiKey)
                  </span>
                </div>
                {/* Single register button — only when no auth method is bound */}
                {!hasAnyAuth && onRegister && (
                  <button
                    onClick={onRegister}
                    className="mt-1 text-[11px] text-red-400 hover:text-red-300 border border-red-900/60 hover:border-red-700/80 px-2 py-0.5 rounded transition-colors leading-tight"
                  >
                    Register →
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Custody */}
          {agent && (
            <div>
              <label className="block text-xs text-zinc-600 mb-1">Signing</label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-300">{custodyLabel}</span>
                <span className="text-xs text-zinc-500">— {custodyDesc}</span>
              </div>
            </div>
          )}

          {/* Registered date */}
          {registeredDate && (
            <div>
              <label className="block text-xs text-zinc-600 mb-1">Registered</label>
              <span className="text-zinc-400 text-xs">
                {new Date(registeredDate).toLocaleDateString(undefined, {
                  year: "numeric", month: "short", day: "numeric",
                })}
              </span>
            </div>
          )}

          {/* Loading state */}
          {!agent && !error && (
            <div className="animate-pulse space-y-2">
              <div className="h-3 bg-zinc-800 rounded w-3/4" />
              <div className="h-3 bg-zinc-800 rounded w-1/2" />
              <div className="h-3 bg-zinc-800 rounded w-2/3" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
