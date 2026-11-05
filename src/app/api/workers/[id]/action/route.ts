import { HttpError, withAdmin } from "@/lib/auth";
import { ok, parseId, readJson } from "@/lib/api";
import { enqueue } from "@/lib/jobs";
import { logActivity } from "@/lib/settings";
import { loadWorker } from "@/lib/workers";

const MAP: Record<string, string> = { start: "worker.start", stop: "worker.stop", restart: "worker.restart", redeploy: "worker.deploy" };

export const POST = withAdmin(async (admin, req, ctx: { params: Promise<{ id: string }> }) => {
  const id = parseId((await ctx.params).id);
  const { action } = await readJson<{ action?: string }>(req);
  const type = MAP[String(action)];
  if (!type) throw new HttpError(400, "Unknown action");
  const w = await loadWorker(id).catch(() => { throw new HttpError(404, "Worker not found"); });
  if (w.status === "deleting") throw new HttpError(409, "Worker is being deleted");
  const job = await enqueue(type, { workerId: id }, { key: `${action}:${id}` });
  await logActivity(admin.username, `worker.${action}`, `worker:${id}`);
  return ok({ jobId: job.id });
});
