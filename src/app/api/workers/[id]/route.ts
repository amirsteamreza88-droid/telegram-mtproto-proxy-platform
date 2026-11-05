import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { proxySecrets, workerConfigs, workers, type Worker } from "@/db/schema";
import { HttpError, withAdmin } from "@/lib/auth";
import { ok, optInt, parseId, readJson, serializeWorker } from "@/lib/api";
import { isValidDomain, isValidPort, isValidSecret, isValidWorkerName, PROXY_MODES, type ProxyMode } from "@/lib/core/mtproto";
import { randomHex } from "@/lib/crypto";
import { enqueue } from "@/lib/jobs";
import { logActivity } from "@/lib/settings";
import { checkPort, createSecretRecord, loadWorker, workerLinks } from "@/lib/workers";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAdmin(async (_a, _req, ctx: Ctx) => {
  const id = parseId((await ctx.params).id);
  const w = await loadWorker(id).catch(() => { throw new HttpError(404, "Worker not found"); });
  const links = await workerLinks(w).catch(() => null);
  const configs = await db.select().from(workerConfigs).where(eq(workerConfigs.workerId, id)).orderBy(desc(workerConfigs.id)).limit(10);
  return ok({ worker: await serializeWorker(w), links: links ? { host: links.host, tg: links.tg, https: links.https } : null, configs });
});

export const PATCH = withAdmin(async (admin, req, ctx: Ctx) => {
  const id = parseId((await ctx.params).id);
  const w = await loadWorker(id).catch(() => { throw new HttpError(404, "Worker not found"); });
  if (["deploying", "deleting"].includes(w.status)) throw new HttpError(409, `Worker is ${w.status}`);
  const b = await readJson(req);
  const dbOnly: Partial<Worker> = {};
  const net: Partial<Worker> = {};
  const restart: Partial<Worker> = {};

  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!isValidWorkerName(name)) throw new HttpError(400, "Invalid name");
    dbOnly.name = name;
  }
  if (b.autoRestart !== undefined) dbOnly.autoRestart = !!b.autoRestart;
  if (b.downloadKbps !== undefined) net.downloadKbps = optInt(b.downloadKbps, "downloadKbps", 64, 10_000_000);
  if (b.uploadKbps !== undefined) net.uploadKbps = optInt(b.uploadKbps, "uploadKbps", 64, 10_000_000);
  if (b.bwLimitEnabled !== undefined) net.bwLimitEnabled = !!b.bwLimitEnabled;
  if (b.maxConnections !== undefined) net.maxConnections = optInt(b.maxConnections, "maxConnections", 1, 1_000_000);
  if (b.connLimitEnabled !== undefined) net.connLimitEnabled = !!b.connLimitEnabled;
  if (b.port !== undefined && Number(b.port) !== w.port) {
    const port = Number(b.port);
    if (!isValidPort(port)) throw new HttpError(400, "Invalid port");
    const c = await checkPort(port, id);
    if (c) throw new HttpError(409, c);
    restart.port = port;
  }
  if (b.mode !== undefined && b.mode !== w.mode) {
    if (!PROXY_MODES.includes(b.mode as ProxyMode)) throw new HttpError(400, "Invalid mode");
    restart.mode = String(b.mode);
  }
  const newMode = restart.mode ?? w.mode;
  if (newMode === "faketls" && (b.tlsDomain !== undefined || restart.mode)) {
    const d = String(b.tlsDomain ?? w.tlsDomain ?? "").trim().toLowerCase();
    if (!isValidDomain(d)) throw new HttpError(400, "Fake-TLS requires a valid hostname");
    if (d !== w.tlsDomain) restart.tlsDomain = d;
  }
  let newSecret: string | null = null;
  if (b.regenerateSecret) newSecret = randomHex(16);
  if (b.customSecret) {
    const s = String(b.customSecret).trim().toLowerCase();
    if (!isValidSecret(s)) throw new HttpError(400, "Secret must be 32 hex chars");
    newSecret = s;
  }

  const all = { ...dbOnly, ...net, ...restart };
  const final = { ...w, ...all };
  if (final.connLimitEnabled && !final.maxConnections) throw new HttpError(400, "Set maxConnections to enable the connection limit");
  if (final.bwLimitEnabled && !final.downloadKbps && !final.uploadKbps) throw new HttpError(400, "Set a download or upload limit to enable bandwidth limits");

  const needsRestart = Object.keys(restart).length > 0 || newSecret != null;
  const previous: Partial<Worker> = { port: w.port, mode: w.mode, tlsDomain: w.tlsDomain };
  const prevSecret = (await db.select({ id: proxySecrets.id }).from(proxySecrets).where(and(eq(proxySecrets.workerId, id), eq(proxySecrets.active, true))).limit(1))[0];
  await db.update(workers).set({ ...all, updatedAt: new Date(), ...(needsRestart ? { configVersion: w.configVersion + 1 } : {}) }).where(eq(workers.id, id));
  if (newSecret) await createSecretRecord(id, newSecret);

  let jobId: string | null = null;
  if (needsRestart) {
    jobId = (await enqueue("worker.update", { workerId: id, previous, previousSecretId: prevSecret?.id }, { key: `update:${id}:${w.configVersion + 1}` })).id;
  } else if (Object.keys(net).length && w.status === "active") {
    jobId = (await enqueue("worker.net", { workerId: id }, { key: `net:${id}:${Date.now()}` })).id;
  }
  await logActivity(admin.username, "worker.edit", `worker:${id}`, { fields: Object.keys(all), secretRotated: !!newSecret });
  return ok({ worker: await serializeWorker(await loadWorker(id)), jobId });
});

export const DELETE = withAdmin(async (admin, _req, ctx: Ctx) => {
  const id = parseId((await ctx.params).id);
  await loadWorker(id).catch(() => { throw new HttpError(404, "Worker not found"); });
  const job = await enqueue("worker.delete", { workerId: id }, { key: `delete:${id}` });
  await logActivity(admin.username, "worker.delete_requested", `worker:${id}`);
  return ok({ jobId: job.id });
});
