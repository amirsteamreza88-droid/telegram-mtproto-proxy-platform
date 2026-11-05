import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { activityLogs } from "@/db/schema";
import { withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";

export const GET = withAdmin(async (_a, req) => {
  const sp = new URL(req.url).searchParams;
  const conds: SQL[] = [];
  const level = sp.get("level");
  const q = sp.get("q");
  if (level) conds.push(eq(activityLogs.level, level));
  if (q) conds.push(or(ilike(activityLogs.action, `%${q}%`), ilike(activityLogs.actor, `%${q}%`), ilike(activityLogs.target, `%${q}%`))!);
  const rows = await db.select().from(activityLogs).where(conds.length ? and(...conds) : undefined).orderBy(desc(activityLogs.ts)).limit(300);
  return ok({ logs: rows });
});
