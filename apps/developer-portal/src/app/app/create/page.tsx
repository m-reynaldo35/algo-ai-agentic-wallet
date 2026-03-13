"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import CreateAgentWizard from "@/components/customer/CreateAgentWizard";

export default function CreateAgentPage() {
  const router = useRouter();

  const handleCreated = useCallback(() => {
    router.push("/app/dashboard");
  }, [router]);

  const handleClose = useCallback(() => {
    router.push("/");
  }, [router]);

  return (
    <div className="min-h-screen bg-black">
      <CreateAgentWizard
        onClose={handleClose}
        onCreated={handleCreated}
      />
    </div>
  );
}
