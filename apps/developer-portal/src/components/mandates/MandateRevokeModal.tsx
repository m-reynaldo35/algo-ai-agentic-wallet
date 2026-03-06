"use client";

import { useState } from "react";
import LiquidAuthQRModal from "./LiquidAuthQRModal";
import type { MandateRecord } from "./MandateTable";

interface Props {
  agentId:   string;
  mandate:   MandateRecord;
  onRevoked: () => void;
  onClose:   () => void;
}

type AuthMethod = "liquid" | "webauthn";

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

function microUsdcToUsdc(val: string | number | undefined): string {
  if (val === undefined || val === null) return "—";
  try {
    return (Number(val) / 1_000_000).toFixed(2);
  } catch {
    return String(val);
  }
}

function formatExpiry(expiresAt?: string | null): string {
  if (!expiresAt) return "No expiry";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const days  = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days > 0) return `in ${days}d ${hours}h`;
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  return `in ${hours}h ${mins}m`;
}

export default function MandateRevokeModal({ agentId, mandate, onRevoked, onClose }: Props) {
  const [authMethod, setAuthMethod] = useState<AuthMethod>("liquid");
  const [showQR,     setShowQR]     = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState("");

  async function revokeWithSession(body: Record<string, unknown>) {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/${agentId}/mandate/${mandate.mandateId}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ownerWalletId is required by the server for both auth paths
        body: JSON.stringify({ ownerWalletId: mandate.ownerWalletId, ...body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onRevoked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleWebAuthn() {
    if (!window.PublicKeyCredential) {
      setError("Passkeys are not supported in this browser.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const challengeRes = await fetch(`/api/agents/${agentId}/mandate/challenge`, { method: "POST" });
      if (!challengeRes.ok) throw new Error(`Challenge failed: HTTP ${challengeRes.status}`);
      const { challenge: nonce, allowCredentials } = await challengeRes.json() as { challenge: string; allowCredentials?: { id: string; type: string }[] };

      // Server expects SHA256(nonce + ":" + mandateId + ":revoke")
      const data = new TextEncoder().encode(`${nonce}:${mandate.mandateId}:revoke`);
      const challengeBuf = await crypto.subtle.digest("SHA-256", data);

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge:        challengeBuf,
          allowCredentials: (allowCredentials || []).map((c: { id: string; type: string }) => ({
            id:   base64urlToBuf(c.id),
            type: c.type as PublicKeyCredentialType,
          })),
          timeout:          60_000,
          userVerification: "preferred",
        },
      }) as PublicKeyCredential | null;

      if (!assertion) throw new Error("Passkey authentication cancelled.");

      await revokeWithSession({ webauthnAssertion: serializeAssertion(assertion) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
        <div className="absolute inset-0 bg-black/70" />
        <div
          className="relative bg-zinc-900 border border-zinc-700 rounded-lg max-w-sm w-full p-6"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between mb-5">
            <h2 className="text-white font-semibold text-lg">Revoke Mandate</h2>
            <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Mandate summary */}
          <div className="bg-zinc-800 rounded-md px-4 py-3 space-y-2 text-sm mb-5">
            <div className="flex justify-between">
              <span className="text-zinc-500">Mandate ID</span>
              <span className="font-mono text-zinc-300">{mandate.mandateId.slice(0, 12)}…</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Per-Tx cap</span>
              <span className="text-zinc-300">{mandate.maxPerTxMicroUsdc !== undefined ? `$${microUsdcToUsdc(mandate.maxPerTxMicroUsdc)}` : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Per-Day cap</span>
              <span className="text-zinc-300">{mandate.maxPerDayMicroUsdc !== undefined ? `$${microUsdcToUsdc(mandate.maxPerDayMicroUsdc)}` : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Expiry</span>
              <span className="text-zinc-300">{formatExpiry(mandate.expiresAt)}</span>
            </div>
          </div>

          {/* Auth method toggle */}
          <div className="flex gap-2 mb-5 p-1 bg-zinc-800 rounded-md">
            <button
              onClick={() => setAuthMethod("liquid")}
              className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                authMethod === "liquid" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              Wallet QR
            </button>
            <button
              onClick={() => setAuthMethod("webauthn")}
              className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                authMethod === "webauthn" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              Passkey
            </button>
          </div>

          {/* Warning */}
          <p className="text-sm text-amber-400 mb-4">
            This will permanently revoke the mandate. The agent will no longer be able to use it.
          </p>

          {/* Error */}
          {error && (
            <p className="mb-4 text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-md px-3 py-2">{error}</p>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            {authMethod === "liquid" ? (
              <button
                onClick={() => setShowQR(true)}
                disabled={submitting}
                className="flex-1 py-2 rounded-md bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                Revoke via Wallet QR
              </button>
            ) : (
              <button
                onClick={handleWebAuthn}
                disabled={submitting}
                className="flex-1 py-2 rounded-md bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {submitting ? "Revoking…" : "Sign & Revoke"}
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
          intent="mandate-revoke"
          onVerified={(sid) => {
            setShowQR(false);
            revokeWithSession({ liquidAuthSessionId: sid });
          }}
          onClose={() => setShowQR(false)}
        />
      )}
    </>
  );
}
