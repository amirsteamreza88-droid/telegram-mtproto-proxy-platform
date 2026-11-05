import { withAdmin } from "@/lib/auth";
import { ok, parseId } from "@/lib/api";
import { enqueue } from "@/lib/jobs";
import { logActivity } from "@/lib/settings";

export const POST = withAdmin(async (admin, _req, ctx: { params: Promise<{ id: string }> }) => {
  const id = parseId((await ctx.params).id);
  const job = await enqueue("backup.restore", { backupId: id }, { key: "backup:restore" });
  await logActivity(admin.username, "backup.restore_requested", `backup:${id}`);
  return ok({ jobId: job.id });
});
