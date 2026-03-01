"use client";

import { useState, useCallback } from "react";
import LiquidAuthQRModal from "@/components/mandates/LiquidAuthQRModal";
import MandateTable, { type MandateRecord } from "@/components/mandates/MandateTable";
import MandateCreateModal from "@/components/mandates/MandateCreateModal";
import MandateRevokeModal from "@/components/mandates/MandateRevokeModal";

const AUTH_TOKEN_PLACEHOLDER = JSON.stringify(
  { agentId: "<agentId>", timestamp: "<iso8601>", nonce: "<uuid>", sig: "<ed25519-hex>" },
  null, 2,
);

export default function MandatesPage() {
  // Agent lookup
  const [agentIdInput,  setAgentIdInput]  = useState("");
  const [agentId,       setAgentId]       = useState<string | null>(null);
  const [loading,       setLoading]       = useState(false);
  const [loadError,     setLoadError]     = useState("");

  // Mandates
  const [mandates,      setMandates]      = useState<MandateRecord[]>([]);
  const [ownerAddress,  setOwnerAddress]  = useState<string | null>(null);

  // Modals
  const [showRegisterQR, setShowRegisterQR] = useState(false);
  const [showCreate,     setShowCreate]     = useState(false);
  const [revokeTarget,   setRevokeTarget]   = useState<MandateRecord | null>(null);

  // Approval token
  const [atExpanded,  setAtExpanded]  = useState(false);
  const [atAmount,    setAtAmount]    = useState("");
  const [atWalletId,  setAtWalletId]  = useState("");
  const [atTxns,      setAtTxns]      = useState("");
  const [atAuthToken, setAtAuthToken] = useState("");
  const [atNonce,     setAtNonce]     = useState<string | null>(null);
  const [atError,     setAtError]     = useState("");
  const [atLoading,   setAtLoading]   = useState(false);

  const loadMandates = useCallback(async (id: string) => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/agents/${id}/mandates`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setMandates(data.mandates ?? data ?? []);
      if (data.ownerAddress) setOwnerAddress(data.ownerAddress);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  async function handleLoad() {
    const id = agentIdInput.trim();
    if (!id) return;
    setAgentId(id);
    setOwnerAddress(null);
    setMandates([]);
    await loadMandates(id);
  }

  async function handleRegisterVerified(sessionId: string) {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/auth/liquid-register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liquidAuthSessionId: sessionId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.ownerAddress) setOwnerAddress(data.ownerAddress);
    } catch {
      // non-fatal — QR modal already closed
    }
    setShowRegisterQR(false);
  }

  async function handleApprovalToken() {
    if (!agentId) return;
    setAtLoading(true);
    setAtError("");
    setAtNonce(null);
    try {
      const body: Record<string, unknown> = {};
      if (atAmount)    body.amountMicroUsdc = String(Math.round(parseFloat(atAmount) * 1_000_000));
      if (atWalletId)  body.walletId = atWalletId.trim();
      if (atTxns.trim()) {
        try { body.unsignedTxns = JSON.parse(atTxns); } catch { body.unsignedTxns = atTxns; }
      }
      if (atAuthToken.trim()) {
        try { body.authToken = JSON.parse(atAuthToken); } catch { body.authToken = atAuthToken; }
      }
      const res = await fetch(`/api/agents/${agentId}/approval-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setAtNonce(data.nonce ?? data.approvalNonce ?? JSON.stringify(data));
    } catch (err) {
      setAtError(err instanceof Error ? err.message : String(err));
    } finally {
      setAtLoading(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Mandate Management</h1>
        <p className="text-zinc-400 text-sm mt-1">Manage spending authorizations for your AI agents</p>
      </div>

      {/* Agent Lookup */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 mb-6">
        <h2 className="text-white font-semibold mb-4">Agent Lookup</h2>
        <div className="flex gap-3">
          <input
            value={agentIdInput}
            onChange={(e) => setAgentIdInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLoad()}
            placeholder="Enter Agent ID…"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm font-mono placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
          />
          <button
            onClick={handleLoad}
            disabled={loading || !agentIdInput.trim()}
            className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium transition-colors whitespace-nowrap"
          >
            {loading ? "Loading…" : "Load Mandates"}
          </button>
        </div>
        {loadError && (
          <p className="mt-3 text-sm text-red-400">{loadError}</p>
        )}
      </div>

      {agentId && (
        <>
          {/* Owner Registration */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 mb-6">
            <h2 className="text-white font-semibold mb-1">Owner Registration</h2>
            <p className="text-zinc-400 text-sm mb-4">
              Register your Algorand address as this agent&apos;s governance key.
            </p>
            {ownerAddress && (
              <div className="flex items-center gap-2 mb-4 text-sm text-zinc-400">
                <span className="text-zinc-500">Current owner:</span>
                <span className="font-mono text-zinc-300 truncate max-w-xs" title={ownerAddress}>
                  {ownerAddress.slice(0, 20)}…
                </span>
              </div>
            )}
            <button
              onClick={() => setShowRegisterQR(true)}
              className="px-4 py-2 rounded-md bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium transition-colors"
            >
              Register via Wallet QR
            </button>
          </div>

          {/* Active Mandates */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-semibold">
                Mandates
                <span className="ml-2 text-zinc-500 text-sm font-normal">({mandates.length})</span>
              </h2>
              <button
                onClick={() => setShowCreate(true)}
                disabled={!ownerAddress}
                title={!ownerAddress ? "Register an owner first" : undefined}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New Mandate
              </button>
            </div>
            <MandateTable
              mandates={mandates}
              onRevoke={setRevokeTarget}
            />
          </div>

          {/* Approval Token (collapsible) */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden mb-6">
            <button
              onClick={() => setAtExpanded((v) => !v)}
              className="w-full flex items-center justify-between px-6 py-4 text-white font-semibold hover:bg-zinc-800/50 transition-colors"
            >
              <span>Approval Tokens</span>
              <svg
                className={`w-4 h-4 text-zinc-400 transition-transform ${atExpanded ? "rotate-90" : ""}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>

            {atExpanded && (
              <div className="px-6 pb-6 border-t border-zinc-800 pt-5 space-y-4">
                <p className="text-zinc-400 text-sm">
                  Issue a one-time approval nonce for a pending transaction.
                  Pass as <code className="font-mono text-emerald-400 text-xs">X-Approval-Nonce</code> header when resubmitting.
                </p>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Amount (USDC)</label>
                    <input
                      type="number" min="0" step="0.01" placeholder="0.00"
                      value={atAmount} onChange={(e) => setAtAmount(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm focus:outline-none focus:border-zinc-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Wallet ID</label>
                    <input
                      placeholder="agent-wallet-id"
                      value={atWalletId} onChange={(e) => setAtWalletId(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-zinc-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Unsigned Transactions (JSON)</label>
                  <textarea
                    rows={3} placeholder='[{"txn": "..."}]'
                    value={atTxns} onChange={(e) => setAtTxns(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-zinc-500 resize-none"
                  />
                </div>

                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Auth Token (JSON)</label>
                  <textarea
                    rows={4}
                    placeholder={AUTH_TOKEN_PLACEHOLDER}
                    value={atAuthToken} onChange={(e) => setAtAuthToken(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-zinc-500 resize-none"
                  />
                </div>

                {atError && (
                  <p className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-md px-3 py-2">{atError}</p>
                )}

                {atNonce && (
                  <div className="bg-zinc-800 rounded-md px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-zinc-500 uppercase tracking-wider">Approval Nonce</span>
                      <button
                        onClick={() => navigator.clipboard.writeText(atNonce!)}
                        className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                      >
                        Copy
                      </button>
                    </div>
                    <p className="font-mono text-emerald-400 text-sm break-all">{atNonce}</p>
                  </div>
                )}

                <button
                  onClick={handleApprovalToken}
                  disabled={atLoading}
                  className="px-4 py-2 rounded-md bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                >
                  {atLoading ? "Issuing…" : "Issue Approval Token"}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Modals */}
      {showRegisterQR && agentId && (
        <LiquidAuthQRModal
          agentId={agentId}
          intent="register"
          onVerified={handleRegisterVerified}
          onClose={() => setShowRegisterQR(false)}
        />
      )}

      {showCreate && agentId && ownerAddress && (
        <MandateCreateModal
          agentId={agentId}
          ownerWalletId={ownerAddress}
          onCreated={() => { setShowCreate(false); loadMandates(agentId); }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {revokeTarget && agentId && (
        <MandateRevokeModal
          agentId={agentId}
          mandate={revokeTarget}
          onRevoked={() => { setRevokeTarget(null); loadMandates(agentId); }}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}
