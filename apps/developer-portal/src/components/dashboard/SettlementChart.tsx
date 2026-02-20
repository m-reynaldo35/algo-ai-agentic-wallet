"use client";

import { useState, useEffect } from "react";
import { SETTLEMENT_VOLUME_7D } from "@/lib/mock-data";
import SparklineBar from "./SparklineBar";

interface VolumePoint {
  label: string;
  value: number;
}

type Range = "7d" | "14d" | "30d";
type ChainFilter = "all" | "ethereum" | "solana" | "base";

const CHAIN_COLORS: Record<ChainFilter, string> = {
  all:      "text-zinc-400",
  ethereum: "text-violet-400",
  solana:   "text-emerald-400",
  base:     "text-blue-400",
};

export default function SettlementChart() {
  const [data, setData] = useState<VolumePoint[]>(SETTLEMENT_VOLUME_7D);
  const [total, setTotal] = useState(() => SETTLEMENT_VOLUME_7D.reduce((s, d) => s + d.value, 0));
  const [range, setRange] = useState<Range>("7d");
  const [chain, setChain] = useState<ChainFilter>("all");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const days = range === "7d" ? 7 : range === "14d" ? 14 : 30;
    const params = new URLSearchParams({ days: String(days) });
    if (chain !== "all") params.set("chain", chain);

    fetch(`/api/live/settlement-volume?${params}`)
      .then((r) => r.ok ? r.json() : Promise.reject(r))
      .then((json) => {
        if (Array.isArray(json.data) && json.data.length > 0) {
          setData(json.data);
          setTotal(json.total ?? (json.data as VolumePoint[]).reduce((s, d) => s + d.value, 0));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [range, chain]);

  const maxValue = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-200">Settlement Volume</h3>
          <p className="text-sm text-zinc-500">On-chain atomic settlements</p>
        </div>
        <div className="text-right">
          <p className={`text-2xl font-mono font-bold ${loading ? "text-zinc-600" : "text-white"}`}>
            {total}
          </p>
          <p className="text-xs text-zinc-500">total · {range}</p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {/* Range picker */}
        <div className="flex rounded-md border border-zinc-700 overflow-hidden text-xs">
          {(["7d", "14d", "30d"] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 ${range === r ? "bg-zinc-700 text-white" : "bg-zinc-800 text-zinc-500 hover:text-white"}`}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Chain filter */}
        <div className="flex rounded-md border border-zinc-700 overflow-hidden text-xs">
          {(["all", "ethereum", "solana", "base"] as ChainFilter[]).map((c) => (
            <button
              key={c}
              onClick={() => setChain(c)}
              className={`px-2.5 py-1 capitalize ${
                chain === c
                  ? `bg-zinc-700 ${CHAIN_COLORS[c]}`
                  : "bg-zinc-800 text-zinc-500 hover:text-white"
              }`}
            >
              {c === "all" ? "All Chains" : c}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="flex items-end gap-1 h-24">
        {data.map((d, i) => {
          const pct = maxValue > 0 ? (d.value / maxValue) * 100 : 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
              <div className="relative w-full flex items-end justify-center" style={{ height: "76px" }}>
                <div
                  className={`w-full rounded-sm transition-all ${
                    chain === "all"     ? "bg-zinc-600 group-hover:bg-zinc-400" :
                    chain === "ethereum" ? "bg-violet-700 group-hover:bg-violet-500" :
                    chain === "solana"   ? "bg-emerald-700 group-hover:bg-emerald-500" :
                                          "bg-blue-700 group-hover:bg-blue-500"
                  }`}
                  style={{ height: `${Math.max(pct, 2)}%` }}
                />
                {d.value > 0 && (
                  <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-xs text-white bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100 whitespace-nowrap pointer-events-none transition-opacity">
                    {d.value}
                  </span>
                )}
              </div>
              <span className="text-[10px] text-zinc-600">{d.label}</span>
            </div>
          );
        })}
      </div>

      {/* Chain legend */}
      <div className="flex gap-4 mt-3 pt-3 border-t border-zinc-800">
        {(["ethereum", "solana", "base"] as ChainFilter[]).map((c) => (
          <span key={c} className={`text-xs flex items-center gap-1.5 ${CHAIN_COLORS[c]}`}>
            <span className="w-2 h-2 rounded-full inline-block bg-current opacity-80" />
            {c.charAt(0).toUpperCase() + c.slice(1)}
          </span>
        ))}
      </div>
    </div>
  );
}
