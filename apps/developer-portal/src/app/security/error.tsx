"use client";

import { useEffect } from "react";

export default function SecurityError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[SecurityPage error]", error);
  }, [error]);

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      <div className="rounded-lg border border-red-800 bg-red-950/40 px-5 py-4">
        <p className="text-red-300 font-semibold text-sm mb-1">Security page error</p>
        <p className="text-red-400/80 text-xs font-mono">{error.message}</p>
        {error.digest && <p className="text-zinc-600 text-xs mt-1 font-mono">{error.digest}</p>}
        <button
          onClick={reset}
          className="mt-3 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-xs text-zinc-300 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
