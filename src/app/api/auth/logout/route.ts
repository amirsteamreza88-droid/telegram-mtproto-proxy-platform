import { NextResponse } from "next/server";
import { destroySession, getAdmin } from "@/lib/auth";
import { logActivity } from "@/lib/settings";

export async function POST() {
  const a = await getAdmin();
  await destroySession();
  if (a) await logActivity(a.username, "auth.logout");
  return NextResponse.json({ ok: true });
}
