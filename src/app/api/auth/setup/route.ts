import { NextResponse } from "next/server";
import { count } from "drizzle-orm";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { clientIp, createSession, rateLimit } from "@/lib/auth";
import { hashPassword } from "@/lib/crypto";
import { logActivity } from "@/lib/settings";

// First-run setup. Only usable while NO administrator exists.
// install.sh creates the admin through scripts/create-admin.mjs, so on a properly
// installed server this endpoint is permanently disabled.
async function needsSetup() {
  const r = await db.select({ n: count() }).from(admins);
  return Number(r[0].n) === 0;
}

export async function GET() {
  return NextResponse.json({ needsSetup: await needsSetup() });
}

export async function POST(req: Request) {
  const ip = await clientIp();
  if (!rateLimit(`setup:${ip}`, 5, 15 * 60_000)) return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  if (!(await needsSetup())) return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  const token = process.env.SETUP_TOKEN;
  let body: { username?: string; password?: string; token?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }
  if (token && body.token !== token) return NextResponse.json({ error: "Invalid setup token" }, { status: 403 });
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return NextResponse.json({ error: "Username: 3-32 chars [a-zA-Z0-9_.-]" }, { status: 400 });
  if (password.length < 12) return NextResponse.json({ error: "Password must be at least 12 characters" }, { status: 400 });
  const [a] = await db.insert(admins).values({ username, passwordHash: hashPassword(password) }).returning();
  await createSession(a.id);
  await logActivity(username, "auth.setup_admin_created", null, null, "info", ip);
  return NextResponse.json({ ok: true });
}
