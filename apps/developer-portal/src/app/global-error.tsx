"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-black text-white">
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
          <div className="text-center">
            <p className="font-mono text-xs text-zinc-500 uppercase tracking-widest mb-3">
              x402 Portal
            </p>
            <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
            <p className="text-zinc-400 text-sm max-w-sm">
              This error has been reported automatically. Try refreshing — if it
              persists, contact support.
            </p>
            {error.digest && (
              <p className="font-mono text-xs text-zinc-600 mt-3">
                {error.digest}
              </p>
            )}
          </div>
          <button
            onClick={reset}
            className="px-5 py-2.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-sm font-medium transition-colors border border-zinc-700"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
