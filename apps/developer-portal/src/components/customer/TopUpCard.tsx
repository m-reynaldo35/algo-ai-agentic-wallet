"use client";

import { useCallback, useEffect, useState } from "react";

const NETWORK       = process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet";
const USDC_ASSET_ID = NETWORK === "mainnet" ? 31566704 : 10458941;

const MBR_MICRO          = 200_000;
const GAS_CRITICAL_MICRO = 50_000;
const GAS_LOW_MICRO      = 200_000;
const REFUEL_TARGET_ALGO = MBR_MICRO + 700_000;
const TOLL_MICRO         = 10_000;
const LOW_USDC_THRESHOLD = 5 * TOLL_MICRO;
const REFUEL_TARGET_USDC = 10_000_000; // $10

interface Balance { microAlgo: number; microUsdc: number; }

function gasStatus(n: number) {
  const above = n - MBR_MICRO;
  if (above < GAS_CRITICAL_MICRO) return "critical" as const;
  if (above < GAS_LOW_MICRO)      return "low" as const;
  return "ok" as const;
}
function txRemaining(n: number) { return Math.floor(Math.max(0, n - MBR_MICRO) / 1_000); }
function pmtRemaining(n: number) { return Math.floor(n / TOLL_MICRO); }

export default function TopUpCard({ address }: { address: string }) {
  const [balance, setBalance] = useState<Balance | null>(null);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await fetch(`/api/customer/balance/${address}`);
      if (res.ok) setBalance(await res.json() as Balance);
    } catch { /* silent */ }
  }, [address]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) fetchBalance(); }, 12_000);
    return () => clearInterval(id);
  }, [fetchBalance]);

  const gas         = balance ? gasStatus(balance.microAlgo) : null;
  const txLeft      = balance ? txRemaining(balance.microAlgo) : null;
  const pmtLeft     = balance ? pmtRemaining(balance.microUsdc) : null;
  const usdcEmpty   = balance !== null && balance.microUsdc === 0;
  const usdcLow     = balance !== null && !usdcEmpty && balance.microUsdc < LOW_USDC_THRESHOLD;

  const algoTopUp   = balance ? Math.max(0, REFUEL_TARGET_ALGO - balance.microAlgo) : REFUEL_TARGET_ALGO;
  const usdcTopUp   = balance ? Math.max(0, REFUEL_TARGET_USDC - balance.microUsdc) : REFUEL_TARGET_USDC;

  const algoLink    = `algorand://${address}?amount=${algoTopUp}`;
  const usdcLink    = `algorand://${address}?asset=${USDC_ASSET_ID}&amount=${usdcTopUp}`;

  const algoColor   = gas === "critical" ? "text-red-400" : gas === "low" ? "text-amber-400" : "text-emerald-400";
  const usdcColor   = usdcEmpty ? "text-red-400" : usdcLow ? "text-amber-400" : "text-emerald-400";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 flex flex-col gap-4">
      <h2 className="text-xs text-zinc-500 uppercase tracking-wider">Top Up</h2>

      {/* ALGO gas */}
      <div className="flex-1 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-400 font-medium">ALGO Gas</span>
          <span className={`text-xs font-medium tabular-nums ${algoColor}`}>
            {txLeft !== null ? `~${txLeft} txns` : "—"}
          </span>
        </div>
        <p className="text-[11px] text-zinc-600 leading-relaxed">
          ~0.001 ALGO per payment · suggested {(algoTopUp / 1_000_000).toFixed(3)} ALGO
        </p>
        <div className="flex gap-1.5">
          <a href={algoLink}
            className="flex-1 text-center px-2 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-xs rounded transition-colors font-medium">
            Open in Wallet
          </a>
          <a href="https://perawallet.app/" target="_blank" rel="noopener noreferrer"
            className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs rounded transition-colors">
            Pera
          </a>
          <a href="https://defly.app/" target="_blank" rel="noopener noreferrer"
            className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs rounded transition-colors">
            Defly
          </a>
        </div>
      </div>

      <div className="border-t border-zinc-800" />

      {/* USDC payments */}
      <div className="flex-1 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-400 font-medium">USDC Payments</span>
          <span className={`text-xs font-medium tabular-nums ${usdcColor}`}>
            {balance !== null
              ? usdcEmpty ? "empty" : `~${pmtLeft} payments`
              : "—"}
          </span>
        </div>
        <p className="text-[11px] text-zinc-600 leading-relaxed">
          $0.01 per payment · suggested ${(usdcTopUp / 1_000_000).toFixed(2)} USDC (asset {USDC_ASSET_ID})
        </p>
        <div className="flex gap-1.5">
          <a href={usdcLink}
            className="flex-1 text-center px-2 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-xs rounded transition-colors font-medium">
            Open in Wallet
          </a>
          <a href="https://perawallet.app/" target="_blank" rel="noopener noreferrer"
            className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs rounded transition-colors">
            Pera
          </a>
          <a href="https://defly.app/" target="_blank" rel="noopener noreferrer"
            className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs rounded transition-colors">
            Defly
          </a>
        </div>
      </div>
    </div>
  );
}
