import { redirect } from "next/navigation";

export default function CustomerAppRoot() {
  redirect("/app/dashboard");
}
