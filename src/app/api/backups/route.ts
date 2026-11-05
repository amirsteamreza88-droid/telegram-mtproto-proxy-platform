import { desc } from "drizzle-orm";
import { db } from "@/db";
import { backups } from "@/db/schema";
import { withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";
import { enqueue } from "@/lib/jobs";
import { logActivity } from "@/lib/settings";

export const GET = withAdmin(async () => ok({ backups: await db.select().from(backups).orderBy(desc(backups.createdAt)) }));

export const POST = withAdmin(async (admin) => {
  const job = await enqueue("backup.create", { kind: "manual" }, { key: "backup:manual" });
  await logActivity(admin.username, "backup.requested");
  return ok({ jobId: job.id });
});
