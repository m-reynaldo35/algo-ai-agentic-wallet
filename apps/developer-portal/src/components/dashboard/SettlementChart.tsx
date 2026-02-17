"use client";

import { SETTLEMENT_VOLUME_7D } from "@/lib/mock-data";
import SparklineBar from "./SparklineBar";

export default function SettlementChart() {
  const total = SETTLEMENT_VOLUME_7D.reduce((s, d) => s + d.value, 0);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-200">Settlement Volume</h3>
          <p className="text-sm text-zinc-500">Last 7 days</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-mono font-bold text-white">{total}</p>
          <p className="text-xs text-zinc-500">total settlements</p>
        </div>
      </div>
      <SparklineBar data={SETTLEMENT_VOLUME_7D} />
    </div>
  );
}
