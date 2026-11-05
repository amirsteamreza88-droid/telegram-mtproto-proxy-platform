import { NextResponse } from "next/server";
import { pool } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await pool.query("SELECT 1");
    return NextResponse.json({ status: "ok", database: "ok", time: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ status: "degraded", database: "error", error: (e as Error).message }, { status: 503 });
  }
}
