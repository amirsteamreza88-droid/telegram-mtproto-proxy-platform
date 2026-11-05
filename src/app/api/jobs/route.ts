import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";

export const GET = withAdmin(async (_a, req) => {
  const status = new URL(req.url).searchParams.get("status");
  const q = db.select().from(jobs);
  const rows = await (status ? q.where(eq(jobs.status, status)) : q).orderBy(desc(jobs.createdAt)).limit(200);
  return ok({ jobs: rows });
});
