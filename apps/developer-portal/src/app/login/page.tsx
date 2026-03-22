import { redirect } from "next/navigation";

interface Props {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function OldLoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const from = params.from;
  if (from) {
    redirect(`/sign-in?from=${encodeURIComponent(from)}`);
  }
  redirect("/sign-in");
}
