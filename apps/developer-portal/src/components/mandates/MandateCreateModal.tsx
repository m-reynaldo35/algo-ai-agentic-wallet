"use client";

import { useState, useEffect } from "react";
import LiquidAuthQRModal from "./LiquidAuthQRModal";

interface Props {
  agentId:       string;
  ownerWalletId: string;
  agentAddress?: string;
  onCreated:     () => void;
  onClose:       () => void;
}

export default function MandateCreateModal({ agentId, ownerWalletId: ownerWalletIdProp, agentAddress: agentAddressProp, onCreated, onClose }: Props) {
  const [sessionId,    setSessionId]    = useState<string | null>(null);
  const [showQR,       setShowQR]       = useState(false);

  // Fetch agent record on open — get both display address and ownerWalletId for payload
  const [agentAddress,  setAgentAddress]  = useState(agentAddressProp ?? "");
  const [ownerWalletId, setOwnerWalletId] = useState(ownerWalletIdProp ?? "");

  useEffect(() => {
    fetch(`/api/agents/${agentId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: { address?: string; ownerWalletId?: string } | null) => {
        if (!data) return;
        if (data.address)       setAgentAddress(data.address);
        if (data.ownerWalletId) setOwnerWalletId(data.ownerWalletId);
      })
      .catch(() => {});
  }, [agentId]);

  // Form fields
  const [maxPerTx,     setMaxPerTx]     = useState("");
  const [maxPer10Min,  setMaxPer10Min]  = useState("");
  const [maxPerDay,    setMaxPerDay]    = useState("");
  const [recipients,   setRecipients]   = useState("");
  const [expiresAt,    setExpiresAt]    = useState("");
  const [recurring,    setRecurring]    = useState(false);
  const [recurAmount,  setRecurAmount]  = useState("");
  const [recurInterval,setRecurInterval]= useState("");

  const [submitting,   setSubmitting]   = useState(false);
  const [error,        setError]        = useState("");

  function buildPayload(extra: Record<string, unknown>) {
    const payload: Record<string, unknown> = { ownerWalletId };
    // Field names must match server's CreateMandateInput exactly (micro-USDC strings)
    if (maxPerTx)    payload.maxPerTx    = String(Math.round(parseFloat(maxPerTx)    * 1_000_000));
    if (maxPer10Min) payload.maxPer10Min = String(Math.round(parseFloat(maxPer10Min) * 1_000_000));
    if (maxPerDay)   payload.maxPerDay   = String(Math.round(parseFloat(maxPerDay)   * 1_000_000));
    if (recipients.trim()) payload.allowedRecipients = recipients.split("\n").map((s) => s.trim()).filter(Boolean);
    if (expiresAt)   payload.expiresAt = new Date(expiresAt).getTime(); // Unix ms — server expects number
    if (recurring && recurAmount && recurInterval) {
      payload.recurring = {
        amount:          String(Math.round(parseFloat(recurAmount) * 1_000_000)), // server field is "amount"
        intervalSeconds: parseInt(recurInterval, 10),
      };
    }
    return { ...payload, ...extra };
  }

  async function handleLiquidSubmit() {
    if (!expiresAt) { setError("An expiry date is required."); return; }
    if (!sessionId) { setShowQR(true); return; }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/${agentId}/mandate/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload({ peraSessionId: sessionId })),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
        <div className="absolute inset-0 bg-black/70" />
        <div
          className="relative bg-zinc-900 border border-zinc-700 rounded-lg max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between mb-5">
            <h2 className="text-white font-semibold text-lg">Create Mandate</h2>
            <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Form fields */}
          <div className="space-y-4">
            {/* Owner (readonly) — show the agent's blockchain address */}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Agent Wallet Address</label>
              <input
                readOnly
                value={agentAddress || ownerWalletId || ""}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-zinc-400 text-sm font-mono cursor-not-allowed"
              />
            </div>

            {/* Spending caps */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Max Per-Tx (USDC)",    val: maxPerTx,    set: setMaxPerTx },
                { label: "Max Per-10min (USDC)",  val: maxPer10Min, set: setMaxPer10Min },
                { label: "Max Per-Day (USDC)",    val: maxPerDay,   set: setMaxPerDay },
              ].map(({ label, val, set }) => (
                <div key={label}>
                  <label className="block text-xs text-zinc-500 mb-1">{label}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={val}
                    onChange={(e) => set(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm focus:outline-none focus:border-zinc-500"
                  />
                </div>
              ))}
            </div>

            {/* Allowed recipients */}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Allowed Recipients (one address per line, optional)</label>
              <textarea
                rows={3}
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder={"ALGO_ADDRESS_1\nALGO_ADDRESS_2"}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-zinc-500 resize-none"
              />
            </div>

            {/* Expiry */}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">
                Expiry <span className="text-red-400">*</span>
              </label>
              <input
                type="date"
                required
                value={expiresAt}
                min={new Date().toISOString().split("T")[0]}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm focus:outline-none focus:border-zinc-500 [color-scheme:dark]"
              />
            </div>

            {/* Recurring toggle */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recurring}
                  onChange={(e) => setRecurring(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-emerald-500"
                />
                <span className="text-sm text-zinc-300">Recurring payment</span>
              </label>
              {recurring && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Amount (USDC)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={recurAmount}
                      onChange={(e) => setRecurAmount(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm focus:outline-none focus:border-zinc-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Interval (seconds, min 60)</label>
                    <input
                      type="number"
                      min="60"
                      placeholder="3600"
                      value={recurInterval}
                      onChange={(e) => setRecurInterval(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm focus:outline-none focus:border-zinc-500"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Liquid Auth status banner */}
          {sessionId && (
            <div className="mt-4 flex items-center gap-2 px-3 py-2 bg-emerald-900/30 border border-emerald-800 rounded-md text-emerald-400 text-sm">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Wallet verified ✓
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="mt-3 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-md px-3 py-2">{error}</p>
          )}

          {/* Action buttons */}
          <div className="mt-5 flex gap-3">
            {!sessionId ? (
              <button
                onClick={() => setShowQR(true)}
                className="flex-1 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
              >
                Continue to Wallet Sign
              </button>
            ) : (
              <button
                onClick={handleLiquidSubmit}
                disabled={submitting}
                className="flex-1 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {submitting ? "Creating…" : "Create Mandate"}
              </button>
            )}
            <button
              onClick={onClose}
              className="flex-1 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>

      {/* QR Modal */}
      {showQR && (
        <LiquidAuthQRModal
          agentId={agentId}
          intent="mandate-create"
          onVerified={(sid) => { setSessionId(sid); setShowQR(false); }}
          onClose={() => setShowQR(false)}
        />
      )}
    </>
  );
}
