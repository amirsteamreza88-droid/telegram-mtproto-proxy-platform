import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { clientIp, createSession, rateLimit } from "@/lib/auth";
import { verifyPassword } from "@/lib/crypto";
import { logActivity } from "@/lib/settings";

export async function POST(req: Request) {
  const ip = await clientIp();
  if (!rateLimit(`login:${ip}`, 10, 15 * 60_000)) {
    await logActivity("anonymous", "auth.rate_limited", null, null, "warn", ip);
    return NextResponse.json({ error: "Too many login attempts. Try again later." }, { status: 429 });
  }
  let body: { username?: string; password?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }
  const username = String(body.username || "").trim().slice(0, 64);
  const password = String(body.password || "").slice(0, 256);
  const rows = await db.select().from(admins).where(eq(admins.username, username)).limit(1);
  const a = rows[0];
  // constant-ish time: verify against a dummy hash when user is missing
  const valid = a ? verifyPassword(password, a.passwordHash) : (verifyPassword(password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"), false);
  if (!a || !valid) {
    await logActivity(username || "anonymous", "auth.login_failed", null, null, "warn", ip);
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }
  await createSession(a.id);
  await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, a.id));
  await logActivity(a.username, "auth.login", null, null, "info", ip);
  return NextResponse.json({ ok: true });
}
