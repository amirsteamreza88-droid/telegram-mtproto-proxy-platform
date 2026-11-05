import { NextResponse } from "next/server";
import { getAdmin } from "@/lib/auth";

export async function GET() {
  const a = await getAdmin();
  if (!a) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ admin: a });
}
