import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { HttpError, withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";
import { enqueue } from "@/lib/jobs";
import { logActivity } from "@/lib/settings";

export const POST = withAdmin(async (admin, _req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const [j] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!j) throw new HttpError(404, "Job not found");
  if (j.status !== "failed") throw new HttpError(409, "Only failed jobs can be retried");
  const n = await enqueue(j.type, j.payload as Record<string, unknown>, { key: j.idempotencyKey ?? undefined });
  await logActivity(admin.username, "job.retry", `job:${id}`, { newJob: n.id });
  return ok({ jobId: n.id });
});
