"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import QRCode from "qrcode";

const NETWORK = process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet";
const USDC_ASSET_ID = NETWORK === "mainnet" ? 31566704 : 10458941;
/** $0.05 USDC = 5 x402 payments remaining */
const LOW_USDC_THRESHOLD_MICRO = 50_000;
/**
 * Gas thresholds (µALGO above MBR of 200 000 µALGO):
 *   critical  < 50 000  (~50 txns remaining)
 *   low       < 200 000 (~200 txns remaining)
 */
const MBR_MICRO              = 200_000;
const GAS_CRITICAL_MICRO     = 50_000;
const GAS_LOW_MICRO          = 200_000;
/** Target ALGO reserve after refuel: ~700 txns above MBR */
const REFUEL_TARGET_MICRO    = MBR_MICRO + 700_000;

interface Props {
  address: string;
  showQR?: boolean;
}

interface Balance {
  microAlgo: number;
  microUsdc: number;
}

type GasStatus = "ok" | "low" | "critical" | null;

function formatAlgo(microAlgo: number): string {
  return (microAlgo / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}

function formatUsdc(microUsdc: number): string {
  return (microUsdc / 1_000_000).toFixed(2);
}

function gasStatus(microAlgo: number): GasStatus {
  const above = microAlgo - MBR_MICRO;
  if (above < 0)             return "critical";
  if (above < GAS_CRITICAL_MICRO) return "critical";
  if (above < GAS_LOW_MICRO)      return "low";
  return "ok";
}

function gasRemaining(microAlgo: number): number {
  const above = Math.max(0, microAlgo - MBR_MICRO);
  return Math.floor(above / 1_000);
}

export default function WalletCard({ address, showQR = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied]         = useState(false);
  const [balance, setBalance]       = useState<Balance | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [showRefuel, setShowRefuel] = useState(false);

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, address, {
        width: 160,
        margin: 1,
        color: { dark: "#000000", light: "#ffffff" },
      });
    }
  }, [address]);

  const fetchBalance = useCallback(async () => {
    setRefreshing(true);
    setBalanceError("");
    try {
      const res = await fetch(`/api/customer/balance/${address}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as Balance;
      setBalance(data);
    } catch (err) {
      setBalanceError(err instanceof Error ? err.message : "Failed to load balance");
    } finally {
      setRefreshing(false);
    }
  }, [address]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  useEffect(() => {
    const tick = () => { if (!document.hidden) fetchBalance(); };
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, [fetchBalance]);

  function copyAddress() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const truncated      = address.length > 24
    ? `${address.slice(0, 12)}…${address.slice(-10)}`
    : address;
  const isLowUsdc      = balance !== null && balance.microUsdc < LOW_USDC_THRESHOLD_MICRO;
  const gas            = balance !== null ? gasStatus(balance.microAlgo) : null;
  const txRemaining    = balance !== null ? gasRemaining(balance.microAlgo) : null;
  const recommendedAlgo = balance !== null
    ? Math.max(0, REFUEL_TARGET_MICRO - balance.microAlgo)
    : REFUEL_TARGET_MICRO;
  const algoRefuelUri  = `algorand://${address}?amount=${recommendedAlgo}`;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <h2 className="text-xs text-zinc-500 uppercase tracking-wider mb-4">
        Wallet &amp; Balance
      </h2>

      {/* ALGO gas warning */}
      {gas === "critical" && balance !== null && (
        <div className="mb-3 flex items-start gap-2 bg-red-900/30 border border-red-700/50 rounded-md px-3 py-2.5">
          <svg className="w-4 h-4 text-red-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div className="flex-1">
            <p className="text-red-400 text-xs leading-relaxed">
              Critical ALGO gas — ~{txRemaining} transactions remaining. Refuel now to keep paying.
            </p>
            <button
              onClick={() => setShowRefuel(true)}
              className="mt-1.5 text-xs text-red-300 hover:text-white underline underline-offset-2"
            >
              Refuel →
            </button>
          </div>
        </div>
      )}

      {gas === "low" && balance !== null && (
        <div className="mb-3 flex items-start gap-2 bg-amber-900/30 border border-amber-700/50 rounded-md px-3 py-2.5">
          <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div className="flex-1">
            <p className="text-amber-400 text-xs leading-relaxed">
              Low ALGO gas — ~{txRemaining} transactions remaining.
            </p>
            <button
              onClick={() => setShowRefuel(true)}
              className="mt-1.5 text-xs text-amber-300 hover:text-white underline underline-offset-2"
            >
              Refuel →
            </button>
          </div>
        </div>
      )}

      {/* USDC low balance warning */}
      {isLowUsdc && (
        <div className="mb-3 flex items-start gap-2 bg-amber-900/20 border border-amber-700/40 rounded-md px-3 py-2.5">
          <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <p className="text-amber-400 text-xs leading-relaxed">
            Low USDC balance — fewer than 5 payments remaining. Top up to keep your agent running.
          </p>
        </div>
      )}

      <div className="flex gap-4">
        {showQR && (
          <div className="shrink-0">
            <div className="bg-zinc-800 rounded-md flex items-center justify-center" style={{ width: 80, height: 80 }}>
              <canvas ref={canvasRef} style={{ width: 80, height: 80 }} />
            </div>
            <p className="text-xs text-zinc-600 mt-1 text-center">Scan</p>
          </div>
        )}

        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Address</label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-zinc-300 text-xs truncate" title={address}>{truncated}</span>
              <button
                onClick={copyAddress}
                title="Copy address"
                className="shrink-0 text-zinc-500 hover:text-emerald-400 transition-colors"
              >
                {copied ? (
                  <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {balanceError ? (
            <p className="text-red-400 text-xs">{balanceError}</p>
          ) : balance ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">ALGO</span>
                <span className={`text-sm font-medium tabular-nums ${
                  gas === "critical" ? "text-red-400" : gas === "low" ? "text-amber-400" : "text-white"
                }`}>
                  {formatAlgo(balance.microAlgo)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">USDC</span>
                <span className={`text-sm font-medium tabular-nums ${isLowUsdc ? "text-amber-400" : "text-white"}`}>
                  ${formatUsdc(balance.microUsdc)}
                </span>
              </div>
            </div>
          ) : (
            <div className="animate-pulse space-y-1.5">
              <div className="h-3 bg-zinc-800 rounded" />
              <div className="h-3 bg-zinc-800 rounded" />
            </div>
          )}

          <button
            onClick={fetchBalance}
            disabled={refreshing}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
          >
            <svg className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Top Up */}
      <div className="mt-4 pt-4 border-t border-zinc-800 space-y-3">
        <div>
          <p className="text-xs text-zinc-500 mb-2">Top up USDC (asset {USDC_ASSET_ID}):</p>
          <div className="flex flex-wrap gap-2">
            <a href="https://perawallet.app/" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-md transition-colors">
              Pera
            </a>
            <a href="https://defly.app/" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-md transition-colors">
              Defly
            </a>
          </div>
        </div>

        <button
          onClick={() => setShowRefuel(true)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs rounded-md transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Refuel ALGO
        </button>
      </div>

      {/* Refuel modal */}
      {showRefuel && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4" onClick={() => setShowRefuel(false)}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white">Refuel ALGO Gas</h3>
              <button onClick={() => setShowRefuel(false)} className="text-zinc-500 hover:text-zinc-300">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-xs text-zinc-400 mb-4">
              Send ALGO to your agent wallet to cover transaction fees.
              Each x402 payment costs ~0.001 ALGO in fees.
            </p>

            <div className="bg-zinc-800 rounded-md p-3 space-y-2 mb-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">Current gas</span>
                <span className={`text-xs font-medium ${gas === "critical" ? "text-red-400" : gas === "low" ? "text-amber-400" : "text-emerald-400"}`}>
                  {txRemaining !== null ? `~${txRemaining} txns` : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">Recommended top-up</span>
                <span className="text-xs font-medium text-white">
                  {(recommendedAlgo / 1_000_000).toFixed(3)} ALGO
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <a
                href={algoRefuelUri}
                className="block w-full text-center px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-md transition-colors"
              >
                Open in Wallet App
              </a>
              <div className="flex gap-2">
                <a href="https://perawallet.app/" target="_blank" rel="noopener noreferrer"
                  className="flex-1 text-center px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-md transition-colors">
                  Pera
                </a>
                <a href="https://defly.app/" target="_blank" rel="noopener noreferrer"
                  className="flex-1 text-center px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-md transition-colors">
                  Defly
                </a>
              </div>
              <p className="text-xs text-zinc-600 text-center">
                Send to: <span className="font-mono">{address.slice(0, 10)}…{address.slice(-8)}</span>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
