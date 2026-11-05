import { withAdmin } from "@/lib/auth";
import { ok, readJson } from "@/lib/api";
import { manualRestore } from "@/lib/protection";
import { logActivity } from "@/lib/settings";

export const POST = withAdmin(async (admin, req) => {
  const b = await readJson<{ workerId?: number | null }>(req);
  const wid = b.workerId ? Number(b.workerId) : null;
  const n = await manualRestore(wid, admin.username);
  await logActivity(admin.username, "protection.manual_restore", wid ? `worker:${wid}` : "all", { lifted: n });
  return ok({ lifted: n });
});
