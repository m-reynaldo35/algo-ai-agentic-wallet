"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { PeraWalletConnect as PeraWalletConnectType } from "@perawallet/connect";

interface Props {
  agentId:    string;
  intent:     "register" | "mandate-create" | "mandate-revoke";
  onVerified: (sessionId: string) => void;
  onClose:    () => void;
}

const INTENT_LABELS: Record<Props["intent"], string> = {
  "register":       "Connect your Algorand wallet to register as governance key for this agent.",
  "mandate-create": "Connect your Algorand wallet to authorize mandate creation.",
  "mandate-revoke": "Connect your Algorand wallet to authorize mandate revocation.",
};

export default function LiquidAuthQRModal({ agentId, intent, onVerified, onClose }: Props) {
  const peraRef = useRef<PeraWalletConnectType | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "signing" | "verifying" | "verified" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    import("@perawallet/connect").then(({ PeraWalletConnect }) => {
      peraRef.current = new PeraWalletConnect();
      // Auto-start on mount
      handleConnect();
    });
    return () => { peraRef.current?.disconnect().catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = useCallback(async () => {
    const pera = peraRef.current;
    if (!pera) return;

    setStatus("connecting");
    setErrorMsg("");

    try {
      // 1. Get challenge
      const chalRes = await fetch(`/api/agents/${agentId}/auth/pera-challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent }),
      });
      if (!chalRes.ok) {
        const b = await chalRes.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${chalRes.status}`);
      }
      const { challengeId, challengeB64 } = await chalRes.json() as {
        challengeId: string; challengeB64: string;
      };

      // 2. Connect wallet — opens WalletConnect modal
      const accounts = await pera.connect();
      const address = accounts[0];

      // 3. Sign challenge
      setStatus("signing");
      const challengeBytes = Uint8Array.from(atob(challengeB64), (c) => c.charCodeAt(0));
      const intentMsg = {
        "register":       `Register as owner of agent ${agentId}`,
        "mandate-create": `Authorize mandate creation for agent ${agentId}`,
        "mandate-revoke": `Authorize mandate revocation for agent ${agentId}`,
      }[intent];
      const signatures = await pera.signData(
        [{ data: challengeBytes, message: intentMsg }],
        address,
      );
      const signatureB64 = btoa(String.fromCharCode(...signatures[0]));

      // 4. Verify
      setStatus("verifying");
      const verifyRes = await fetch(`/api/agents/${agentId}/auth/pera-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, intent, address, signatureB64 }),
      });
      if (!verifyRes.ok) {
        const b = await verifyRes.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${verifyRes.status}`);
      }
      const { verifiedSessionId } = await verifyRes.json() as { verifiedSessionId: string };

      setStatus("verified");
      onVerified(verifiedSessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Session currently disconnected") || msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("closed")) {
        setStatus("idle");
      } else {
        setStatus("error");
        setErrorMsg(msg);
      }
    }
  }, [agentId, intent, onVerified]);

  const busy = status === "connecting" || status === "signing" || status === "verifying";

  const statusLine: Record<typeof status, string | null> = {
    idle:       null,
    connecting: "Opening wallet — scan the QR in the Pera app…",
    signing:    "Sign the request in your Pera app…",
    verifying:  "Verifying…",
    verified:   "Verified ✓",
    error:      null,
  };

  const modal = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/80" />
      <div
        className="relative bg-zinc-900 border border-zinc-700 rounded-lg max-w-sm w-full p-6 flex flex-col items-center gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="w-full flex items-start justify-between">
          <h2 className="text-white font-semibold text-lg">Connect Algorand Wallet</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors ml-4">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-zinc-400 text-sm text-center">{INTENT_LABELS[intent]}</p>

        {/* Status */}
        {statusLine[status] && (
          <div className="flex items-center gap-2 text-sm">
            {(status === "connecting" || status === "signing" || status === "verifying") && (
              <svg className="animate-spin w-4 h-4 shrink-0 text-emerald-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {status === "verified" && (
              <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            <span className={status === "verified" ? "text-emerald-400 font-medium" : "text-zinc-400"}>
              {statusLine[status]}
            </span>
          </div>
        )}

        {status === "error" && errorMsg && (
          <div className="rounded-lg bg-red-950/50 border border-red-800 px-3 py-2 text-xs text-red-300 text-center w-full">
            {errorMsg}
          </div>
        )}

        <p className="text-zinc-600 text-xs text-center">
          Works with Pera, Defly, Kibisis, and any WalletConnect-compatible Algorand wallet
        </p>

        {/* Action buttons */}
        <div className="flex gap-3 w-full mt-1">
          {(status === "idle" || status === "error") && (
            <button
              onClick={handleConnect}
              className="flex-1 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
            >
              {status === "error" ? "Retry" : "Connect Wallet"}
            </button>
          )}
          {busy && (
            <button
              disabled
              className="flex-1 py-2 rounded-md bg-emerald-600 opacity-50 cursor-not-allowed text-white text-sm font-medium flex items-center justify-center gap-2"
            >
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Working…
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
  );

  if (typeof document === "undefined") return null;
  return createPortal(modal, document.body);
}
