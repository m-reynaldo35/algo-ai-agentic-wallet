"use client";

export interface MandateRecord {
  mandateId:          string;
  ownerWalletId:      string;
  maxPerTxMicroUsdc?: string | number;
  maxPer10MinMicroUsdc?: string | number;
  maxPerDayMicroUsdc?: string | number;
  expiresAt?:         string | null;
  status:             "active" | "revoked" | string;
  allowedRecipients?: string[];
}

interface Props {
  mandates: MandateRecord[];
  onRevoke: (mandate: MandateRecord) => void;
}

function microUsdcToUsdc(val: string | number | undefined): string {
  if (val === undefined || val === null) return "—";
  try {
    return (Number(val) / 1_000_000).toFixed(2);
  } catch {
    return String(val);
  }
}

function formatExpiry(expiresAt?: string | null): string {
  if (!expiresAt) return "No expiry";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const days  = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days > 0) return `in ${days}d ${hours}h`;
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  return `in ${hours}h ${mins}m`;
}

export default function MandateTable({ mandates, onRevoke }: Props) {
  if (mandates.length === 0) {
    return (
      <div className="text-zinc-500 text-sm py-8 text-center">No mandates found.</div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 text-xs uppercase tracking-wider border-b border-zinc-800">
            <th className="text-left py-3 px-4">Mandate ID</th>
            <th className="text-left py-3 px-4">Owner</th>
            <th className="text-right py-3 px-4">Per-Tx</th>
            <th className="text-right py-3 px-4">Per-10min</th>
            <th className="text-right py-3 px-4">Per-Day</th>
            <th className="text-left py-3 px-4">Expiry</th>
            <th className="text-left py-3 px-4">Status</th>
            <th className="py-3 px-4" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {mandates.map((m) => {
            const isActive = m.status === "active";
            return (
              <tr key={m.mandateId} className="hover:bg-zinc-800/30 transition-colors">
                <td className="py-3 px-4 font-mono text-zinc-300 whitespace-nowrap">
                  {m.mandateId.slice(0, 8)}…
                </td>
                <td className="py-3 px-4 text-zinc-400 whitespace-nowrap">
                  {m.ownerWalletId.slice(0, 16)}…
                </td>
                <td className="py-3 px-4 text-zinc-300 text-right whitespace-nowrap">
                  {m.maxPerTxMicroUsdc !== undefined ? `$${microUsdcToUsdc(m.maxPerTxMicroUsdc)}` : "—"}
                </td>
                <td className="py-3 px-4 text-zinc-300 text-right whitespace-nowrap">
                  {m.maxPer10MinMicroUsdc !== undefined ? `$${microUsdcToUsdc(m.maxPer10MinMicroUsdc)}` : "—"}
                </td>
                <td className="py-3 px-4 text-zinc-300 text-right whitespace-nowrap">
                  {m.maxPerDayMicroUsdc !== undefined ? `$${microUsdcToUsdc(m.maxPerDayMicroUsdc)}` : "—"}
                </td>
                <td className="py-3 px-4 text-zinc-400 whitespace-nowrap">
                  {formatExpiry(m.expiresAt)}
                </td>
                <td className="py-3 px-4">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      isActive
                        ? "bg-emerald-900/50 text-emerald-400"
                        : "bg-red-900/50 text-red-400"
                    }`}
                  >
                    {m.status}
                  </span>
                </td>
                <td className="py-3 px-4">
                  {isActive && (
                    <button
                      onClick={() => onRevoke(m)}
                      className="text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 px-2 py-1 rounded transition-colors"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
