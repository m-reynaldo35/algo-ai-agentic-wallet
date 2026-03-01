"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import QRCode from "qrcode";

interface Props {
  address: string;
}

interface Balance {
  microAlgo: number;
  microUsdc: number;
}

function formatAlgo(microAlgo: number): string {
  return (microAlgo / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}

function formatUsdc(microUsdc: number): string {
  return (microUsdc / 1_000_000).toFixed(2);
}

export default function WalletCard({ address }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, address, {
        width: 160,
        margin: 1,
        color: { dark: "#ffffff", light: "#18181b" },
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

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  function copyAddress() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const truncated = address.length > 24
    ? `${address.slice(0, 12)}…${address.slice(-10)}`
    : address;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <h2 className="text-xs text-zinc-500 uppercase tracking-wider mb-4">
        Wallet &amp; Balance
      </h2>

      <div className="flex gap-4">
        {/* QR Code */}
        <div className="shrink-0">
          <div
            className="bg-zinc-800 rounded-md flex items-center justify-center"
            style={{ width: 80, height: 80 }}
          >
            <canvas ref={canvasRef} style={{ width: 80, height: 80 }} />
          </div>
          <p className="text-xs text-zinc-600 mt-1 text-center">Deposit</p>
        </div>

        {/* Address + balances */}
        <div className="flex-1 min-w-0 space-y-3">
          {/* Address */}
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Address</label>
            <div className="flex items-center gap-2">
              <span
                className="font-mono text-zinc-300 text-xs truncate"
                title={address}
              >
                {truncated}
              </span>
              <button
                onClick={copyAddress}
                title="Copy address"
                className="shrink-0 text-zinc-500 hover:text-emerald-400 transition-colors"
              >
                {copied ? (
                  <svg
                    className="w-3.5 h-3.5 text-emerald-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Balances */}
          {balanceError ? (
            <p className="text-red-400 text-xs">{balanceError}</p>
          ) : balance ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">ALGO</span>
                <span className="text-sm font-medium text-white tabular-nums">
                  {formatAlgo(balance.microAlgo)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">USDC</span>
                <span className="text-sm font-medium text-white tabular-nums">
                  {formatUsdc(balance.microUsdc)}
                </span>
              </div>
            </div>
          ) : (
            <div className="animate-pulse space-y-1.5">
              <div className="h-3 bg-zinc-800 rounded" />
              <div className="h-3 bg-zinc-800 rounded" />
            </div>
          )}

          {/* Refresh */}
          <button
            onClick={fetchBalance}
            disabled={refreshing}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
          >
            <svg
              className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Refresh balance
          </button>
        </div>
      </div>

      <p className="text-xs text-zinc-600 mt-4">
        Deposit ALGO or USDC to this address to fund your agent.
      </p>
    </div>
  );
}
