import { redirect } from "next/navigation";

/**
 * Agent creation is now handled inline from the portfolio dashboard.
 * Redirect any direct visitors to /app/dashboard — the wizard opens from there.
 */
export default function CreateAgentPage() {
  redirect("/app/dashboard");
}
