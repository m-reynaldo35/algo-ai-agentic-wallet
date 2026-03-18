"use client";

import { useState, useEffect } from "react";
import LiquidAuthQRModal from "@/components/mandates/LiquidAuthQRModal";

type BindMethod = "liquid" | "webauthn";

// WebAuthn helpers
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

function serializeRegistration(cred: PublicKeyCredential) {
  const resp = cred.response as AuthenticatorAttestationResponse;
  return {
    id:       cred.id,
    rawId:    bufToBase64url(cred.rawId),
    type:     cred.type,
    response: {
      attestationObject: bufToBase64url(resp.attestationObject),
      clientDataJSON:    bufToBase64url(resp.clientDataJSON),
    },
  };
}

interface Props {
  agentId:  string;
  onDone:   () => void;
  onClose:  () => void;
}

export default function BindWalletModal({ agentId, onDone, onClose }: Props) {
  const [method, setMethod]               = useState<BindMethod>("liquid");
  const [showQR, setShowQR]               = useState(false);
  const [submitting, setSubmitting]       = useState(false);
  const [error, setError]                 = useState("");
  // existingOwnerWalletId: set when the user already has a passkey account
  const [existingOwnerWalletId, setExistingOwnerWalletId] = useState<string | null>(null);

  // On mount, check session for existing passkey-based owner so we can offer
  // "use your existing passkey" (adopt) instead of creating a brand-new credential.
  useEffect(() => {
    fetch("/api/customer/session")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { ownerAddress?: string } | null) => {
        if (data?.ownerAddress?.startsWith("webauthn:")) {
          setExistingOwnerWalletId(data.ownerAddress);
        }
      })
      .catch(() => {});
  }, []);

  async function handleWebAuthnAdopt() {
    // Uses the existing owner passkey to claim this new agent — no new registration.
    if (!window.PublicKeyCredential) {
      setError("Passkeys are not supported in this browser.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      // 1. Issue login challenge for this agent
      const chalRes = await fetch(`/api/agents/${agentId}/auth/webauthn-login-challenge`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!chalRes.ok) throw new Error(`Challenge failed: HTTP ${chalRes.status}`);
      const { challenge, rpId } = await chalRes.json() as {
        challenge: string; rpId: string;
        allowCredentials: Array<{ id: string; type: string }>;
      };

      // 2. Assertion with existing passkey (empty allowCredentials → discoverable)
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge:        base64urlToBuf(challenge),
          allowCredentials: [],
          rpId,
          timeout:          60_000,
          userVerification: "preferred",
        },
      }) as PublicKeyCredential | null;

      if (!cred) throw new Error("Passkey authentication cancelled.");

      const resp = cred.response as AuthenticatorAssertionResponse;
      const assertion = {
        id:    cred.id,
        rawId: bufToBase64url(cred.rawId),
        type:  cred.type,
        response: {
          clientDataJSON:    bufToBase64url(resp.clientDataJSON),
          authenticatorData: bufToBase64url(resp.authenticatorData),
          signature:         bufToBase64url(resp.signature),
          ...(resp.userHandle ? { userHandle: bufToBase64url(resp.userHandle) } : {}),
        },
        clientExtensionResults: cred.getClientExtensionResults(),
      };

      // 3. Call adopt endpoint — binds new agent to existing owner passkey
      const res = await fetch(`/api/agents/${agentId}/auth/webauthn-adopt-owner`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(assertion),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }

      // 4. Refresh session so new agent appears in the list
      await fetch("/api/customer/auth/session-refresh", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ agentId }),
      }).catch(() => {});

      onDone();
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
      const chalRes = await fetch(`/api/agents/${agentId}/auth/webauthn-register-challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!chalRes.ok) throw new Error(`Challenge failed: HTTP ${chalRes.status}`);
      const { challenge, userId, rpId, rpName, userName, userDisplayName } = await chalRes.json() as {
        challenge: string; userId: string; rpId: string; rpName: string;
        userName: string; userDisplayName: string;
      };

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge:              base64urlToBuf(challenge),
          rp:                     { id: rpId, name: rpName },
          user: {
            id:          base64urlToBuf(userId),
            name:        userName,
            displayName: userDisplayName,
          },
          pubKeyCredParams:       [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
          authenticatorSelection: { userVerification: "preferred" },
          timeout:                60_000,
        },
      }) as PublicKeyCredential | null;

      if (!credential) throw new Error("Passkey registration cancelled.");

      const res = await fetch("/api/customer/auth/webauthn-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, registrationResponse: serializeRegistration(credential) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
        <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-zinc-800">
            <div>
              <h2 className="text-sm font-semibold text-white">Bind Wallet</h2>
              <p className="text-xs text-zinc-500 mt-0.5 font-mono">{agentId}</p>
            </div>
            <button
              onClick={onClose}
              className="flex items-center justify-center w-7 h-7 rounded-md bg-red-900/30 hover:bg-red-900/60 text-red-400 hover:text-red-300 transition-colors"
              title="Close"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-5 space-y-4">
            <p className="text-sm text-zinc-400">
              Prove ownership to register an auth method. Required before creating mandates.
            </p>

            {/* Method toggle */}
            <div className="flex gap-2 p-1 bg-zinc-800 rounded-md">
              <button
                onClick={() => setMethod("liquid")}
                className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                  method === "liquid" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
                }`}
              >
                Algorand Wallet QR <span className="text-xs text-emerald-400">(Recommended)</span>
              </button>
              <button
                onClick={() => setMethod("webauthn")}
                className={`flex-1 py-1.5 rounded text-sm font-medium transition-colors ${
                  method === "webauthn" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
                }`}
              >
                Device Passkey
              </button>
            </div>

            {error && (
              <div className="rounded-md bg-red-950/50 border border-red-800 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}

            {method === "liquid" ? (
              <button
                onClick={() => setShowQR(true)}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium py-2.5 rounded-md transition-colors"
              >
                Connect Wallet
              </button>
            ) : existingOwnerWalletId ? (
              // User already has a passkey account — adopt this agent under it
              <div className="space-y-2">
                <div className="flex items-center gap-2 px-3 py-2 bg-emerald-900/20 border border-emerald-800/50 rounded-md text-xs text-emerald-400">
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Existing passkey account detected — no new registration needed.
                </div>
                <button
                  onClick={handleWebAuthnAdopt}
                  disabled={submitting}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-md transition-colors"
                >
                  {submitting ? "Linking…" : "Link with Existing Passkey"}
                </button>
              </div>
            ) : (
              <button
                onClick={handleWebAuthn}
                disabled={submitting}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded-md transition-colors"
              >
                {submitting ? "Registering passkey…" : "Register New Passkey"}
              </button>
            )}
          </div>
        </div>
      </div>

      {showQR && (
        <LiquidAuthQRModal
          agentId={agentId}
          intent="register"
          onVerified={async () => {
            // Refresh the session cookie to include this agentId so the agent
            // appears in the list immediately without a full re-login.
            await fetch("/api/customer/auth/session-refresh", {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ agentId }),
            }).catch(() => {/* non-fatal — agent will appear on next full session load */});
            setShowQR(false);
            onDone();
          }}
          onClose={() => setShowQR(false)}
        />
      )}
    </>
  );
}
