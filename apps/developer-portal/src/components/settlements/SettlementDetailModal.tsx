"use client";

import type { Settlement } from "@/lib/mock-data";

interface Props {
  settlement: Settlement;
  onClose: () => void;
}

export default function SettlementDetailModal({ settlement: s, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Settlement Detail</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white text-xl leading-none">&times;</button>
        </div>

        <div className="space-y-4 text-sm">
          <Row label="ID" value={s.id} />
          <Row label="Time" value={new Date(s.time).toLocaleString()} />
          <Row label="Agent" value={s.agentId} mono />
          <Row label="Status">
            <span className={s.status === "confirmed" ? "text-emerald-400" : "text-red-400"}>
              {s.status}
            </span>
          </Row>
          <Row label="Amount" value={`${(s.amountMicroUsdc / 1e6).toFixed(2)} USDC`} />
          <Row label="Txn ID" value={s.txnId} mono />
          <Row label="Chain" value={s.chain} />
          {s.confirmedRound && <Row label="Confirmed Round" value={String(s.confirmedRound)} />}
          {s.failedStage && <Row label="Failed Stage" value={s.failedStage} />}
          {s.error && <Row label="Error" value={s.error} />}

          {s.oracleContext && (
            <>
              <div className="border-t border-zinc-800 pt-4 mt-4">
                <p className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Oracle Context</p>
              </div>
              <Row label="Asset Pair" value={s.oracleContext.assetPair} />
              <Row label="Gora Price" value={`${(Number(s.oracleContext.goraConsensusPrice) / 1e6).toFixed(4)} USDC/ALGO`} />
              <Row label="Timestamp" value={new Date(s.oracleContext.goraTimestamp * 1000).toLocaleString()} />
              <Row label="Slippage" value={`${s.oracleContext.slippageDelta} bips`} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono, children }: { label: string; value?: string; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-zinc-500 shrink-0">{label}</span>
      <span className={`text-right truncate ${mono ? "font-mono" : ""}`}>
        {children ?? value}
      </span>
    </div>
  );
}
