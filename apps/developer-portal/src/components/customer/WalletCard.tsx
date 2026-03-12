"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import QRCode from "qrcode";

const NETWORK        = process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet";
const USDC_ASSET_ID  = NETWORK === "mainnet" ? 31566704 : 10458941;

// Gas model
const MBR_MICRO           = 200_000;   // minimum balance requirement
const GAS_CRITICAL_MICRO  = 50_000;    // µALGO above MBR → critical
const GAS_LOW_MICRO       = 200_000;   // µALGO above MBR → low
const REFUEL_TARGET_MICRO = MBR_MICRO + 700_000; // top up to ~700 txns above MBR

// USDC model: x402 toll = 10,000 µUSDC per payment
const TOLL_MICRO         = 10_000;
const LOW_USDC_THRESHOLD = 5 * TOLL_MICRO; // < 5 payments → warn
const REFUEL_USDC_TARGET = 10_000_000;     // suggest $10 top-up

interface Props { address: string; showQR?: boolean; }
interface Balance { microAlgo: number; microUsdc: number; }
type GasStatus = "ok" | "low" | "critical" | null;

function formatAlgo(n: number) { return (n / 1_000_000).toFixed(4).replace(/\.?0+$/, "") || "0"; }
function formatUsdc(n: number) { return (n / 1_000_000).toFixed(2); }

function gasStatus(microAlgo: number): GasStatus {
  const above = microAlgo - MBR_MICRO;
  if (above < GAS_CRITICAL_MICRO) return "critical";
  if (above < GAS_LOW_MICRO)      return "low";
  return "ok";
}
function gasRemaining(microAlgo: number) {
  return Math.floor(Math.max(0, microAlgo - MBR_MICRO) / 1_000);
}
function paymentsRemaining(microUsdc: number) {
  return Math.floor(microUsdc / TOLL_MICRO);
}

export default function WalletCard({ address, showQR = true }: Props) {
  const canvasRef                   = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied]         = useState(false);
  const [balance, setBalance]       = useState<Balance | null>(null);
  const [balanceError, setError]    = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [showRefuel, setShowRefuel] = useState(false);

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, address, {
        width: 160, margin: 1,
        color: { dark: "#000000", light: "#ffffff" },
      });
    }
  }, [address]);

  const fetchBalance = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const res = await fetch(`/api/customer/balance/${address}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setBalance(await res.json() as Balance);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load balance");
    } finally {
      setRefreshing(false);
    }
  }, [address]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) fetchBalance(); }, 10_000);
    return () => clearInterval(id);
  }, [fetchBalance]);

  const truncated = `${address.slice(0, 12)}…${address.slice(-10)}`;

  const gas           = balance !== null ? gasStatus(balance.microAlgo) : null;
  const txLeft        = balance !== null ? gasRemaining(balance.microAlgo) : null;
  const pmtLeft       = balance !== null ? paymentsRemaining(balance.microUsdc) : null;
  const usdcEmpty     = balance !== null && balance.microUsdc === 0;
  const usdcLow       = balance !== null && !usdcEmpty && balance.microUsdc < LOW_USDC_THRESHOLD;

  const algoTopUp     = balance !== null ? Math.max(0, REFUEL_TARGET_MICRO - balance.microAlgo) : REFUEL_TARGET_MICRO;
  const usdcTopUp     = balance !== null ? Math.max(0, REFUEL_USDC_TARGET - balance.microUsdc) : REFUEL_USDC_TARGET;
  const algoDeeplink  = `algorand://${address}?amount=${algoTopUp}`;
  const usdcDeeplink  = `algorand://${address}?asset=${USDC_ASSET_ID}&amount=${usdcTopUp}`;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <h2 className="text-xs text-zinc-500 uppercase tracking-wider mb-4">Wallet &amp; Balance</h2>

      {/* ── Warnings ─────────────────────────────────────────── */}
      {gas === "critical" && (
        <div className="mb-3 flex items-start gap-2 bg-red-900/30 border border-red-700/50 rounded-md px-3 py-2.5">
          <svg className="w-4 h-4 text-red-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div className="flex-1">
            <p className="text-red-400 text-xs">Critical ALGO gas — ~{txLeft} transactions remaining. Top up now.</p>
            <button onClick={() => setShowRefuel(true)} className="mt-1 text-xs text-red-300 hover:text-white underline underline-offset-2">Top up →</button>
          </div>
        </div>
      )}
      {gas === "low" && (
        <div className="mb-3 flex items-start gap-2 bg-amber-900/30 border border-amber-700/50 rounded-md px-3 py-2.5">
          <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div className="flex-1">
            <p className="text-amber-400 text-xs">Low ALGO gas — ~{txLeft} transactions remaining.</p>
            <button onClick={() => setShowRefuel(true)} className="mt-1 text-xs text-amber-300 hover:text-white underline underline-offset-2">Top up →</button>
          </div>
        </div>
      )}
      {usdcEmpty && (
        <div className="mb-3 flex items-start gap-2 bg-red-900/20 border border-red-700/40 rounded-md px-3 py-2.5">
          <svg className="w-4 h-4 text-red-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div className="flex-1">
            <p className="text-red-400 text-xs">No USDC — agent cannot make payments.</p>
            <button onClick={() => setShowRefuel(true)} className="mt-1 text-xs text-red-300 hover:text-white underline underline-offset-2">Deposit USDC →</button>
          </div>
        </div>
      )}
      {usdcLow && (
        <div className="mb-3 flex items-start gap-2 bg-amber-900/20 border border-amber-700/40 rounded-md px-3 py-2.5">
          <svg className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <p className="text-amber-400 text-xs">Low USDC — ~{pmtLeft} payment{pmtLeft === 1 ? "" : "s"} remaining.</p>
        </div>
      )}

      {/* ── Address + balances ────────────────────────────────── */}
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
          {/* Address */}
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Address</label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-zinc-300 text-xs truncate" title={address}>{truncated}</span>
              <button
                onClick={() => navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
                className="shrink-0 text-zinc-500 hover:text-emerald-400 transition-colors"
              >
                {copied
                  ? <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                }
              </button>
            </div>
          </div>

          {/* Balances */}
          {balanceError ? (
            <p className="text-red-400 text-xs">{balanceError}</p>
          ) : balance ? (
            <div className="space-y-2">
              {/* ALGO row */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-zinc-500 shrink-0">ALGO</span>
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className={`text-sm font-medium tabular-nums ${
                    gas === "critical" ? "text-red-400" : gas === "low" ? "text-amber-400" : "text-white"
                  }`}>
                    {formatAlgo(balance.microAlgo)}
                  </span>
                  {txLeft !== null && (
                    <span className={`text-xs tabular-nums shrink-0 ${
                      gas === "critical" ? "text-red-500" : gas === "low" ? "text-amber-500" : "text-zinc-600"
                    }`}>
                      ~{txLeft} txns
                    </span>
                  )}
                </div>
              </div>
              {/* USDC row */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-zinc-500 shrink-0">USDC</span>
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className={`text-sm font-medium tabular-nums ${
                    usdcEmpty ? "text-red-400" : usdcLow ? "text-amber-400" : "text-white"
                  }`}>
                    ${formatUsdc(balance.microUsdc)}
                  </span>
                  {pmtLeft !== null && balance.microUsdc > 0 && (
                    <span className={`text-xs tabular-nums shrink-0 ${
                      usdcLow ? "text-amber-500" : "text-zinc-600"
                    }`}>
                      ~{pmtLeft} payments
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="animate-pulse space-y-2">
              <div className="h-3 bg-zinc-800 rounded w-3/4" />
              <div className="h-3 bg-zinc-800 rounded w-1/2" />
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

      {/* ── Top Up button ─────────────────────────────────────── */}
      <div className="mt-4 pt-4 border-t border-zinc-800">
        <button
          onClick={() => setShowRefuel(true)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs rounded-md transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Top Up
        </button>
      </div>

      {/* ── Top Up modal ──────────────────────────────────────── */}
      {showRefuel && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4"
          onClick={() => setShowRefuel(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">Top Up Agent Wallet</h3>
              <button onClick={() => setShowRefuel(false)} className="text-zinc-500 hover:text-zinc-300">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              {/* ALGO section */}
              <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-white">ALGO Gas</span>
                  <span className={`text-xs font-medium ${
                    gas === "critical" ? "text-red-400" : gas === "low" ? "text-amber-400" : "text-emerald-400"
                  }`}>
                    {txLeft !== null ? `~${txLeft} txns left` : "—"}
                  </span>
                </div>
                <p className="text-xs text-zinc-500">
                  Each x402 payment costs ~0.001 ALGO in fees. Suggested top-up: {(algoTopUp / 1_000_000).toFixed(3)} ALGO.
                </p>
                <div className="flex gap-2">
                  <a href={algoDeeplink}
                    className="flex-1 text-center px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-md transition-colors">
                    Open in Wallet
                  </a>
                  <a href="https://perawallet.app/" target="_blank" rel="noopener noreferrer"
                    className="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs rounded-md transition-colors">Pera</a>
                  <a href="https://defly.app/" target="_blank" rel="noopener noreferrer"
                    className="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs rounded-md transition-colors">Defly</a>
                </div>
              </div>

              {/* USDC section */}
              <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-white">USDC Payments</span>
                  <span className={`text-xs font-medium ${
                    usdcEmpty ? "text-red-400" : usdcLow ? "text-amber-400" : "text-emerald-400"
                  }`}>
                    {balance !== null
                      ? usdcEmpty ? "empty" : `~${pmtLeft} payments left`
                      : "—"}
                  </span>
                </div>
                <p className="text-xs text-zinc-500">
                  Each x402 payment costs $0.01 USDC. Suggested top-up: ${(usdcTopUp / 1_000_000).toFixed(2)} USDC (asset {USDC_ASSET_ID}).
                </p>
                <div className="flex gap-2">
                  <a href={usdcDeeplink}
                    className="flex-1 text-center px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-md transition-colors">
                    Open in Wallet
                  </a>
                  <a href="https://perawallet.app/" target="_blank" rel="noopener noreferrer"
                    className="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs rounded-md transition-colors">Pera</a>
                  <a href="https://defly.app/" target="_blank" rel="noopener noreferrer"
                    className="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs rounded-md transition-colors">Defly</a>
                </div>
              </div>

              <p className="text-xs text-zinc-600 text-center font-mono">
                {address.slice(0, 12)}…{address.slice(-10)}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
