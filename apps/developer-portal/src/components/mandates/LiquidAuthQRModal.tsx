"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import QRCode from "qrcode";

interface Props {
  agentId:    string;
  intent:     "register" | "mandate-create" | "mandate-revoke";
  onVerified: (sessionId: string) => void;
  onClose:    () => void;
}

const INTENT_LABELS: Record<Props["intent"], string> = {
  "register":       "Scan to register your Algorand wallet as governance key for this agent.",
  "mandate-create": "Scan to authorize mandate creation with your Algorand wallet.",
  "mandate-revoke": "Scan to authorize mandate revocation with your Algorand wallet.",
};

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSecs = Math.ceil(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function LiquidAuthQRModal({ agentId, intent, onVerified, onClose }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  const [sessionId, setSessionId]   = useState<string | null>(null);
  const [expiresAt, setExpiresAt]   = useState<number | null>(null);
  const [msLeft,    setMsLeft]      = useState<number>(0);
  const [status,    setStatus]      = useState<"loading" | "scanning" | "verified" | "expired" | "error">("loading");
  const [errorMsg,  setErrorMsg]    = useState<string>("");

  const stopTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const issueChallenge = useCallback(async () => {
    setStatus("loading");
    setErrorMsg("");
    stopTimers();

    try {
      const res = await fetch(`/api/agents/${agentId}/auth/liquid-challenge`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: { sessionId: string; qrPayload: unknown; expiresAt: string } = await res.json();

      setSessionId(data.sessionId);
      const expMs = new Date(data.expiresAt).getTime();
      setExpiresAt(expMs);
      setMsLeft(expMs - Date.now());
      setStatus("scanning");

      // Render QR
      if (canvasRef.current) {
        await QRCode.toCanvas(canvasRef.current, JSON.stringify(data.qrPayload), {
          width: 240,
          margin: 2,
          color: { dark: "#ffffff", light: "#18181b" },
        });
      }

      // Countdown ticker
      tickRef.current = setInterval(() => {
        const remaining = expMs - Date.now();
        if (remaining <= 0) {
          setMsLeft(0);
          setStatus("expired");
          stopTimers();
        } else {
          setMsLeft(remaining);
        }
      }, 500);

      // Poll for verification
      pollRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/agents/${agentId}/auth/liquid-status/${data.sessionId}`);
          if (!pollRes.ok) return;
          const pollData: { status: string } = await pollRes.json();
          if (pollData.status === "verified") {
            stopTimers();
            setStatus("verified");
            onVerified(data.sessionId);
          }
        } catch {
          // transient network error — keep polling
        }
      }, 2000);

    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [agentId, onVerified, stopTimers]);

  useEffect(() => {
    issueChallenge();
    return stopTimers;
  }, [issueChallenge, stopTimers]);

  const isAmber = msLeft > 0 && msLeft < 60_000;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70" />
      <div
        className="relative bg-zinc-900 border border-zinc-700 rounded-lg max-w-sm w-full p-6 flex flex-col items-center gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="w-full flex items-start justify-between">
          <h2 className="text-white font-semibold text-lg">Scan with Pera or Defly</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors ml-4">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Intent description */}
        <p className="text-zinc-400 text-sm text-center">{INTENT_LABELS[intent]}</p>

        {/* QR Canvas */}
        <div className="relative flex items-center justify-center bg-zinc-800 rounded-md" style={{ width: 240, height: 240 }}>
          <canvas ref={canvasRef} style={{ display: status === "scanning" || status === "verified" ? "block" : "none" }} />
          {(status === "loading") && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-zinc-600 border-t-emerald-400 rounded-full animate-spin" />
            </div>
          )}
          {status === "expired" && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 rounded-md">
              <span className="text-zinc-400 text-sm">QR expired</span>
            </div>
          )}
          {status === "error" && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 rounded-md px-3">
              <span className="text-red-400 text-xs text-center">{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Status line */}
        {status === "scanning" && (
          <div className="flex items-center gap-2 text-zinc-400 text-sm">
            <div className="w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
            Waiting for wallet signature…
          </div>
        )}
        {status === "verified" && (
          <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Verified ✓
          </div>
        )}

        {/* Countdown */}
        {(status === "scanning") && expiresAt && (
          <p className={`text-xs ${isAmber ? "text-amber-400" : "text-zinc-500"}`}>
            Expires in {formatCountdown(msLeft)}
          </p>
        )}

        {/* Refresh / Cancel */}
        <div className="flex gap-3 w-full mt-1">
          {(status === "expired" || status === "error") && (
            <button
              onClick={issueChallenge}
              className="flex-1 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
            >
              Refresh QR
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
}
