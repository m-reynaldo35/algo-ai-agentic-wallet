"use client";

import { useState } from "react";

interface Props {
  code: string;
  language?: string;
}

export default function CodeBlock({ code, language }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative group">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {language && (
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
            <span className="text-xs text-zinc-500">{language}</span>
            <button
              onClick={handleCopy}
              className="text-xs text-zinc-500 hover:text-white transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        )}
        <pre className="p-4 overflow-x-auto text-sm font-mono leading-relaxed">
          <code className="text-zinc-300">{code}</code>
        </pre>
      </div>
      {!language && (
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 text-xs text-zinc-500 hover:text-white bg-zinc-800 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      )}
    </div>
  );
}
