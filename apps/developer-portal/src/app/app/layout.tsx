"use client";

import { usePathname } from "next/navigation";
import CustomerNav from "@/components/customer/CustomerNav";
import { useEffect, useState } from "react";

export default function CustomerAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/app/login";

  const [ownerAddress, setOwnerAddress]   = useState<string>("");
  const [currentAgentId, setCurrentAgentId] = useState<string>("");

  // Extract agentId from /app/dashboard/[agentId]
  useEffect(() => {
    const match = pathname?.match(/^\/app\/dashboard\/([^/]+)/);
    if (match) setCurrentAgentId(match[1]);
  }, [pathname]);

  useEffect(() => {
    if (isLoginPage) return;
    fetch("/api/customer/session")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { ownerAddress?: string; agentId?: string } | null) => {
        if (data?.ownerAddress) setOwnerAddress(data.ownerAddress);
        // Fallback: seed agentId from session if not on a specific agent page
        if (!currentAgentId && data?.agentId) setCurrentAgentId(data.agentId);
      })
      .catch(() => {});
  }, [isLoginPage, currentAgentId]);

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <CustomerNav ownerAddress={ownerAddress} agentId={currentAgentId} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
