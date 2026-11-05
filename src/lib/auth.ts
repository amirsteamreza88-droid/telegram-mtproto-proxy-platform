import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { and, eq, gt, lt } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "@/db";
import { admins, sessions } from "@/db/schema";
import { sha256 } from "./crypto";

export const SESSION_COOKIE = "mtp_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type AdminCtx = { id: number; username: string };

export async function clientIp(): Promise<string> {
  const h = await headers();
  // nginx sets X-Real-IP; backend listens on localhost only so this header is trusted.
  return h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0].trim() || "local";
}

export async function createSession(adminId: number): Promise<void> {
  const token = crypto.randomBytes(32).toString("base64url");
  const h = await headers();
  await db.insert(sessions).values({
    id: sha256(token),
    adminId,
    ip: await clientIp(),
    userAgent: (h.get("user-agent") || "").slice(0, 200),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  const c = await cookies();
  c.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(): Promise<void> {
  const c = await cookies();
  const t = c.get(SESSION_COOKIE)?.value;
  if (t) await db.delete(sessions).where(eq(sessions.id, sha256(t)));
  c.delete(SESSION_COOKIE);
}

export async function getAdmin(): Promise<AdminCtx | null> {
  const c = await cookies();
  const t = c.get(SESSION_COOKIE)?.value;
  if (!t) return null;
  try {
    const rows = await db
      .select({ id: admins.id, username: admins.username })
      .from(sessions)
      .innerJoin(admins, eq(admins.id, sessions.adminId))
      .where(and(eq(sessions.id, sha256(t)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Wrap a route handler: requires a valid admin session, maps errors to JSON. */
export function withAdmin<A extends unknown[]>(
  fn: (admin: AdminCtx, req: Request, ...args: A) => Promise<Response>,
) {
  return async (req: Request, ...args: A): Promise<Response> => {
    try {
      const admin = await getAdmin();
      if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (req.method !== "GET" && req.method !== "HEAD") {
        // CSRF defence in depth (cookie is SameSite=strict too)
        const origin = req.headers.get("origin");
        const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
        if (origin && host && new URL(origin).host !== host) {
          return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
        }
      }
      return await fn(admin, req, ...args);
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      console.error("[api]", e);
      return NextResponse.json({ error: (e as Error).message || "Internal error" }, { status: 500 });
    }
  };
}

// Simple in-memory sliding-window rate limiter (single process deployment).
const gb = globalThis as typeof globalThis & { __mtpRateBuckets?: Map<string, number[]> };
const buckets: Map<string, number[]> = gb.__mtpRateBuckets ?? (gb.__mtpRateBuckets = new Map());
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}
