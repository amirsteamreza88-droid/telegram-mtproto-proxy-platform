import { withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";
import { enqueue } from "@/lib/jobs";
import { logActivity } from "@/lib/settings";

export const POST = withAdmin(async (admin) => {
  const job = await enqueue("host.sync", {}, { key: "host:sync" });
  await logActivity(admin.username, "host.sync_requested");
  return ok({ jobId: job.id });
});
