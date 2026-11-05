import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sponsorships, workers } from "@/db/schema";
import { HttpError, withAdmin } from "@/lib/auth";
import { ok, parseId, readJson } from "@/lib/api";
import { isValidSponsorTag, normalizeTag } from "@/lib/core/mtproto";
import { encrypt } from "@/lib/crypto";
import { enqueue } from "@/lib/jobs";
import { logActivity } from "@/lib/settings";
import { getSecret, loadWorker, resolvePublicHost } from "@/lib/workers";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAdmin(async (_a, _req, ctx: Ctx) => {
  const id = parseId((await ctx.params).id);
  const w = await loadWorker(id).catch(() => { throw new HttpError(404, "Worker not found"); });
  const [sp] = await db.select().from(sponsorships).where(eq(sponsorships.workerId, id));
  const host = w.publicIp || (await resolvePublicHost());
  return ok({
    state: sp?.state ?? "none",
    requestedAt: sp?.requestedAt, activatedAt: sp?.activatedAt, verifiedAt: sp?.verifiedAt,
    tagSet: !!sp?.tagEnc,
    registration: { host, port: w.port, hostPort: host ? `${host}:${w.port}` : null, secret: await getSecret(id), bot: "https://t.me/MTProxybot" },
  });
});

export const POST = withAdmin(async (admin, req, ctx: Ctx) => {
  const id = parseId((await ctx.params).id);
  const w = await loadWorker(id).catch(() => { throw new HttpError(404, "Worker not found"); });
  const b = await readJson<{ action?: string; tag?: string }>(req);
  const [cur] = await db.select().from(sponsorships).where(eq(sponsorships.workerId, id));
  const prev = { state: cur?.state ?? "none", tagEnc: cur?.tagEnc ?? null };
  const upsert = async (v: Partial<typeof sponsorships.$inferInsert>) => {
    await db.insert(sponsorships).values({ workerId: id, ...v }).onConflictDoUpdate({ target: sponsorships.workerId, set: v });
  };
  let jobId: string | null = null;

  if (b.action === "request") {
    await upsert({ state: "waiting", requestedAt: new Date(), tagEnc: prev.state === "active" ? prev.tagEnc : null });
    if (prev.state === "active") {
      // returning to waiting removes the tag from the running config
      await upsert({ state: "waiting", tagEnc: null });
      await db.update(workers).set({ configVersion: w.configVersion + 1 }).where(eq(workers.id, id));
      jobId = (await enqueue("worker.update", { workerId: id, previous: {}, previousSponsor: prev }, { key: `update:${id}:${w.configVersion + 1}` })).id;
    }
    await logActivity(admin.username, "sponsor.waiting", `worker:${id}`);
  } else if (b.action === "none") {
    await upsert({ state: "none", tagEnc: null, activatedAt: null, verifiedAt: null });
    if (prev.state === "active") {
      await db.update(workers).set({ configVersion: w.configVersion + 1 }).where(eq(workers.id, id));
      jobId = (await enqueue("worker.update", { workerId: id, previous: {}, previousSponsor: prev }, { key: `update:${id}:${w.configVersion + 1}` })).id;
    }
    await logActivity(admin.username, "sponsor.removed", `worker:${id}`);
  } else if (b.action === "activate") {
    const tag = normalizeTag(String(b.tag || ""));
    if (!isValidSponsorTag(tag)) throw new HttpError(400, "The tag from @MTProxybot must be exactly 32 hexadecimal characters");
    await upsert({ state: "active", tagEnc: encrypt(tag), activatedAt: new Date(), verifiedAt: null });
    await db.update(workers).set({ configVersion: w.configVersion + 1 }).where(eq(workers.id, id));
    jobId = (await enqueue("worker.update", { workerId: id, previous: {}, previousSponsor: prev }, { key: `update:${id}:${w.configVersion + 1}` })).id;
    await logActivity(admin.username, "sponsor.tag_applied", `worker:${id}`);
  } else {
    throw new HttpError(400, "Unknown action");
  }
  return ok({ ok: true, jobId });
});
