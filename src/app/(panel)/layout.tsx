import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getAdmin } from "@/lib/auth";
import Shell from "@/components/Shell";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const admin = await getAdmin();
  if (!admin) redirect("/login");
  return <Shell username={admin.username}>{children}</Shell>;
}
