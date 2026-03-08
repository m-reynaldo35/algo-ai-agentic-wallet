"use client";

import { useEffect, useRef } from "react";
import QRCode from "qrcode";

const NETWORK = process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet";
const USDC_ASSET_ID = NETWORK === "mainnet" ? 31566704 : 10458941;

interface Props {
  address: string;
}

export default function WalletQRPanel({ address }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, address, {
        width: 200,
        margin: 1,
        color: { dark: "#000000", light: "#ffffff" },
      });
    }
  }, [address]);

  const algoUri  = `algorand://${address}?asset=${USDC_ASSET_ID}`;
  const peraUrl  = "https://app.perawallet.app/";
  const deflyUrl = "https://defly.app/";

  const truncated = address.length > 20
    ? `${address.slice(0, 10)}…${address.slice(-8)}`
    : address;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 flex flex-col items-center gap-4">
      <h2 className="text-xs text-zinc-500 uppercase tracking-wider self-start">Top Up Wallet</h2>

      {/* QR */}
      <div className="bg-white rounded-lg p-2">
        <canvas ref={canvasRef} style={{ width: 200, height: 200, display: "block" }} />
      </div>

      {/* Address */}
      <p
        className="font-mono text-xs text-zinc-400 text-center break-all"
        title={address}
      >
        {truncated}
      </p>

      <p className="text-xs text-zinc-500 text-center leading-relaxed">
        Scan with Pera or Defly to send USDC (asset {USDC_ASSET_ID}) to this address.
      </p>

      {/* Links */}
      <div className="flex flex-col gap-2 w-full">
        <a
          href={algoUri}
          className="flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-md transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          Open in Wallet App
        </a>
        <div className="flex gap-2">
          <a
            href={peraUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-md transition-colors"
          >
            Pera
          </a>
          <a
            href={deflyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-md transition-colors"
          >
            Defly
          </a>
        </div>
      </div>
    </div>
  );
}
