"use client";

import { useState } from "react";
import LiquidAuthQRModal from "./LiquidAuthQRModal";

interface Props {
  agentId:       string;
  ownerWalletId: string;
  onCreated:     () => void;
  onClose:       () => void;
}

type AuthMethod = "liquid" | "webauthn";

// WebAuthn helpers (no extra package needed)
function bufToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlToBuf(b64: string): ArrayBuffer {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const str = atob(padded);
  const buf = new ArrayBuffer(str.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
  return buf;
}

function serializeAssertion(assertion: PublicKeyCredential) {
  const resp = assertion.response as AuthenticatorAssertionResponse;
  return {
    id:       assertion.id,
    rawId:    bufToBase64url(assertion.rawId),
    type:     assertion.type,
    response: {
      authenticatorData: bufToBase64url(resp.authenticatorData),
      clientDataJSON:    bufToBase64url(resp.clientDataJSON),
      signature:         bufToBase64url(resp.signature),
      userHandle:        resp.userHandle ? bufToBase64url(resp.userHandle) : null,
    },
  };
}

export default function MandateCreateModal({ agentId, ownerWalletId, onCreated, onClose }: Props) {
  const [authMethod,   setAuthMethod]   = useState<AuthMethod>("liquid");
  const [sessionId,    setSessionId]    = useState<string | null>(null);
  const [showQR,       setShowQR]       = useState(false);

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
    if (maxPerTx)    payload.maxPerTxMicroUsdc    = String(Math.round(parseFloat(maxPerTx)    * 1_000_000));
    if (maxPer10Min) payload.maxPer10MinMicroUsdc = String(Math.round(parseFloat(maxPer10Min) * 1_000_000));
    if (maxPerDay)   payload.maxPerDayMicroUsdc   = String(Math.round(parseFloat(maxPerDay)   * 1_000_000));
    if (recipients.trim()) payload.allowedRecipients = recipients.split("\n").map((s) => s.trim()).filter(Boolean);
    if (expiresAt)   payload.expiresAt = new Date(expiresAt).toISOString();
    if (recurring && recurAmount && recurInterval) {
      payload.recurring = {
        amountMicroUsdc: String(Math.round(parseFloat(recurAmount) * 1_000_000)),
        intervalSeconds: parseInt(recurInterval, 10),
      };
    }
    return { ...payload, ...extra };
  }

  // --- Liquid Auth path ---
  async function handleLiquidSubmit() {
    if (!sessionId) { setShowQR(true); return; }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/${agentId}/mandate/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload({ liquidAuthSessionId: sessionId })),
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

  // --- WebAuthn path ---
  async function handleWebAuthn() {
    if (!window.PublicKeyCredential) {
      setError("Passkeys are not supported in this browser.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      // Get challenge
      const challengeRes = await fetch(`/api/agents/${agentId}/mandate/challenge`, { method: "POST" });
      if (!challengeRes.ok) throw new Error(`Challenge failed: HTTP ${challengeRes.status}`);
      const { challenge, allowCredentials } = await challengeRes.json();

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge:        base64urlToBuf(challenge),
          allowCredentials: (allowCredentials || []).map((c: { id: string; type: string }) => ({
            id:   base64urlToBuf(c.id),
            type: c.type,
          })),
          timeout:          60_000,
          userVerification: "preferred",
        },
      }) as PublicKeyCredential | null;

      if (!assertion) throw new Error("Passkey authentication cancelled.");

      const res = await fetch(`/api/agents/${agentId}/mandate/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload({ webauthnAssertion: serializeAssertion(assertion) })),
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

          {/* Auth method toggle */}
          <div className="flex gap-2 mb-5 p-1 bg-zinc-800 rounded-md">
            <button
              onClick={() => setAuthMethod("liquid")}
              className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                authMethod === "liquid" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              Algorand Wallet QR <span className="text-xs text-emerald-400">(Recommended)</span>
            </button>
            <button
              onClick={() => setAuthMethod("webauthn")}
              className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                authMethod === "webauthn" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              Device Passkey
            </button>
          </div>

          {/* Form fields */}
          <div className="space-y-4">
            {/* Owner (readonly) */}
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Owner Wallet</label>
              <input
                readOnly
                value={ownerWalletId}
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
              <label className="block text-xs text-zinc-500 mb-1">Expiry (optional)</label>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-white text-sm focus:outline-none focus:border-zinc-500"
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
          {authMethod === "liquid" && sessionId && (
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
            {authMethod === "liquid" ? (
              <>
                {!sessionId && (
                  <button
                    onClick={() => setShowQR(true)}
                    className="flex-1 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
                  >
                    Continue to Wallet Sign
                  </button>
                )}
                {sessionId && (
                  <button
                    onClick={handleLiquidSubmit}
                    disabled={submitting}
                    className="flex-1 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                  >
                    {submitting ? "Creating…" : "Create Mandate"}
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={handleWebAuthn}
                disabled={submitting}
                className="flex-1 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {submitting ? "Signing…" : "Sign with Passkey"}
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
