import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { HttpError, withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";

export const GET = withAdmin(async (_a, _req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const [j] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!j) throw new HttpError(404, "Job not found");
  return ok({ job: j });
});
