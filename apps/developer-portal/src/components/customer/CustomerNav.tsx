"use client";

import { useRouter } from "next/navigation";

interface Props {
  agentId: string;
}

export default function CustomerNav({ agentId }: Props) {
  const router = useRouter();

  async function handleDisconnect() {
    await fetch("/api/customer/auth/logout", { method: "POST" });
    router.push("/app/login");
  }

  const displayId =
    agentId.length > 20
      ? `${agentId.slice(0, 10)}…${agentId.slice(-8)}`
      : agentId;

  return (
    <nav className="sticky top-0 z-40 border-b border-zinc-800 bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-black/80">
      <div className="flex items-center justify-between px-6 h-14">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-7 h-7 rounded bg-emerald-900/60 border border-emerald-800">
            <svg
              className="w-4 h-4 text-emerald-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
              />
            </svg>
          </div>
          <span className="text-white font-semibold text-sm">x402</span>
        </div>

        {/* Agent ID badge */}
        <div className="flex items-center gap-2">
          <span className="text-zinc-500 text-xs hidden sm:block">Agent:</span>
          <span className="font-mono text-zinc-300 text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1">
            {displayId}
          </span>
        </div>

        {/* Disconnect */}
        <button
          onClick={handleDisconnect}
          className="flex items-center gap-1.5 text-zinc-400 hover:text-white text-sm transition-colors"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
            />
          </svg>
          <span className="hidden sm:block">Disconnect</span>
        </button>
      </div>
    </nav>
  );
}
