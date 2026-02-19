"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";

/**
 * PortalShell — conditionally renders the sidebar.
 * The login page uses the same root layout but hides the sidebar.
 */
export default function PortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = pathname === "/login";

  if (isAuthPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
