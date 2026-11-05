import { HttpError, withAdmin } from "@/lib/auth";
import { ok, parseId } from "@/lib/api";
import { logActivity } from "@/lib/settings";
import { getSecret, loadWorker, workerLinks } from "@/lib/workers";

export const GET = withAdmin(async (admin, _req, ctx: { params: Promise<{ id: string }> }) => {
  const id = parseId((await ctx.params).id);
  const w = await loadWorker(id).catch(() => { throw new HttpError(404, "Worker not found"); });
  const secret = await getSecret(id);
  const links = await workerLinks(w);
  await logActivity(admin.username, "worker.secret_viewed", `worker:${id}`);
  return ok({ secret, clientSecret: links.clientSecret, host: links.host, port: w.port, tg: links.tg, https: links.https });
});
