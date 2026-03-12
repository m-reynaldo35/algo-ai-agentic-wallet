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

  const [ownerAddress, setOwnerAddress] = useState<string>("");

  useEffect(() => {
    if (isLoginPage) return;
    fetch("/api/customer/session")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { ownerAddress?: string } | null) => {
        if (data?.ownerAddress) setOwnerAddress(data.ownerAddress);
      })
      .catch(() => {});
  }, [isLoginPage]);

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <CustomerNav ownerAddress={ownerAddress} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
