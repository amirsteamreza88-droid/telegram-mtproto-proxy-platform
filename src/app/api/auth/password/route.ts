import { eq } from "drizzle-orm";
import { db } from "@/db";
import { admins, sessions } from "@/db/schema";
import { HttpError, withAdmin } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { ok, readJson } from "@/lib/api";
import { logActivity } from "@/lib/settings";

export const POST = withAdmin(async (admin, req) => {
  const b = await readJson<{ current?: string; next?: string }>(req);
  const [a] = await db.select().from(admins).where(eq(admins.id, admin.id));
  if (!verifyPassword(String(b.current || ""), a.passwordHash)) throw new HttpError(400, "Current password is incorrect");
  if (String(b.next || "").length < 12) throw new HttpError(400, "New password must be at least 12 characters");
  await db.update(admins).set({ passwordHash: hashPassword(String(b.next)) }).where(eq(admins.id, admin.id));
  await db.delete(sessions).where(eq(sessions.adminId, admin.id));
  await logActivity(admin.username, "auth.password_changed");
  return ok({ ok: true, reloginRequired: true });
});
