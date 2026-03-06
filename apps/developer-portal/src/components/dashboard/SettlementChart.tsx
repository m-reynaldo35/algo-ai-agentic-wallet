"use client";

import { useState, useEffect } from "react";

interface VolumePoint {
  label: string;
  value: number;
}

type Range = "7d" | "14d" | "30d";

export default function SettlementChart() {
  const [data, setData] = useState<VolumePoint[]>([]);
  const [total, setTotal] = useState(0);
  const [range, setRange] = useState<Range>("7d");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const days = range === "7d" ? 7 : range === "14d" ? 14 : 30;
    const params = new URLSearchParams({ days: String(days) });

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
  }, [range]);

  const maxValue = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-200">Settlement Volume</h3>
          <p className="text-sm text-zinc-500">On-chain Algorand settlements</p>
        </div>
        <div className="text-right">
          <p className={`text-2xl font-mono font-bold ${loading ? "text-zinc-600" : "text-white"}`}>
            {total}
          </p>
          <p className="text-xs text-zinc-500">total · {range}</p>
        </div>
      </div>

      {/* Range picker */}
      <div className="flex items-center gap-2 mb-5">
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
      </div>

      {/* Chart */}
      <div className="flex items-end gap-1 h-24">
        {loading && data.length === 0 && (
          <div className="w-full flex items-center justify-center h-full">
            <span className="text-zinc-600 text-sm animate-pulse">Loading...</span>
          </div>
        )}
        {data.map((d, i) => {
          const pct = maxValue > 0 ? (d.value / maxValue) * 100 : 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
              <div className="relative w-full flex items-end justify-center" style={{ height: "76px" }}>
                <div
                  className="w-full rounded-sm bg-zinc-600 group-hover:bg-zinc-400 transition-all"
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
    </div>
  );
}
