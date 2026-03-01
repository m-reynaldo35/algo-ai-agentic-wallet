"use client";

import { useState } from "react";

interface AgentInfo {
  agentId: string;
  status?: string;
  halted?: boolean;
  cohort?: string;
  registeredAt?: string;
  createdAt?: string;
}

interface Props {
  agentId: string;
  agent: AgentInfo | null;
  error?: string;
}

export default function AgentStatusCard({ agentId, agent, error }: Props) {
  const [copied, setCopied] = useState(false);

  function copyId() {
    navigator.clipboard.writeText(agentId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const isHalted = agent?.halted || agent?.status === "halted";
  const registeredDate = agent?.registeredAt || agent?.createdAt;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <h2 className="text-xs text-zinc-500 uppercase tracking-wider mb-4">
        Agent Status
      </h2>

      {error ? (
        <p className="text-red-400 text-sm">{error}</p>
      ) : (
        <div className="space-y-3">
          {/* Agent ID */}
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Agent ID</label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-zinc-200 text-xs break-all flex-1">
                {agentId}
              </span>
              <button
                onClick={copyId}
                title="Copy agent ID"
                className="shrink-0 text-zinc-500 hover:text-emerald-400 transition-colors"
              >
                {copied ? (
                  <svg
                    className="w-4 h-4 text-emerald-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                ) : (
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
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Status */}
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                isHalted
                  ? "bg-red-900/40 text-red-400 border border-red-800"
                  : "bg-emerald-900/40 text-emerald-400 border border-emerald-800"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isHalted ? "bg-red-400" : "bg-emerald-400"
                }`}
              />
              {isHalted ? "Halted" : "Active"}
            </span>
          </div>

          {/* Cohort */}
          {agent?.cohort && (
            <div>
              <label className="block text-xs text-zinc-600 mb-1">Cohort</label>
              <span className="text-zinc-300 text-sm">{agent.cohort}</span>
            </div>
          )}

          {/* Registered date */}
          {registeredDate && (
            <div>
              <label className="block text-xs text-zinc-600 mb-1">Registered</label>
              <span className="text-zinc-400 text-sm">
                {new Date(registeredDate).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
          )}

          {/* Loading state */}
          {!agent && !error && (
            <div className="animate-pulse space-y-2">
              <div className="h-3 bg-zinc-800 rounded w-3/4" />
              <div className="h-3 bg-zinc-800 rounded w-1/2" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
