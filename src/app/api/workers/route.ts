import { asc } from "drizzle-orm";
import { db } from "@/db";
import { sponsorships, workers } from "@/db/schema";
import { HttpError, withAdmin } from "@/lib/auth";
import { ok, optInt, readJson, serializeWorker } from "@/lib/api";
import { isValidDomain, isValidPort, isValidSecret, isValidWorkerName, PROXY_MODES, type ProxyMode } from "@/lib/core/mtproto";
import { randomHex } from "@/lib/crypto";
import { enqueue } from "@/lib/jobs";
import { logActivity } from "@/lib/settings";
import { allocateStatsPort, checkPort, createSecretRecord } from "@/lib/workers";

export const GET = withAdmin(async () => {
  const list = await db.select().from(workers).orderBy(asc(workers.id));
  return ok({ workers: await Promise.all(list.map(serializeWorker)) });
});

export const POST = withAdmin(async (admin, req) => {
  const b = await readJson(req);
  const name = String(b.name || "").trim();
  if (!isValidWorkerName(name)) throw new HttpError(400, "Name: 1-64 letters, digits, space, _ . -");
  const port = Number(b.port);
  if (!isValidPort(port)) throw new HttpError(400, "Invalid port");
  const mode = String(b.mode) as ProxyMode;
  if (!PROXY_MODES.includes(mode)) throw new HttpError(400, "Invalid proxy mode");
  let tlsDomain: string | null = null;
  if (mode === "faketls") {
    tlsDomain = String(b.tlsDomain || "").trim().toLowerCase();
    if (!isValidDomain(tlsDomain)) throw new HttpError(400, "Fake-TLS requires a valid hostname");
  }
  let secret = randomHex(16); // cryptographically secure 16-byte secret
  if (b.customSecret) {
    const s = String(b.customSecret).trim().toLowerCase();
    if (!isValidSecret(s)) throw new HttpError(400, "Custom secret must be exactly 32 hex characters");
    secret = s;
  }
  const maxConnections = optInt(b.maxConnections, "maxConnections", 1, 1_000_000);
  const downloadKbps = optInt(b.downloadKbps, "downloadKbps", 64, 10_000_000);
  const uploadKbps = optInt(b.uploadKbps, "uploadKbps", 64, 10_000_000);
  const sponsorMode = b.sponsorMode === "waiting" ? "waiting" : "none";
  const conflict = await checkPort(port);
  if (conflict) throw new HttpError(409, conflict);
  const statsPort = await allocateStatsPort();

  const [w] = await db.insert(workers).values({
    name, port, statsPort, mode, tlsDomain,
    status: "pending", statusMessage: "Queued for deployment",
    maxConnections, connLimitEnabled: !!b.connLimitEnabled && maxConnections != null,
    downloadKbps, uploadKbps, bwLimitEnabled: !!b.bwLimitEnabled && (downloadKbps != null || uploadKbps != null),
  }).returning();
  await createSecretRecord(w.id, secret);
  await db.insert(sponsorships).values({ workerId: w.id, state: sponsorMode, requestedAt: sponsorMode === "waiting" ? new Date() : null });
  const job = await enqueue("worker.deploy", { workerId: w.id }, { key: `deploy:${w.id}` });
  await logActivity(admin.username, "worker.create", `worker:${w.id}`, { name, port, mode });
  return ok({ worker: await serializeWorker(w), jobId: job.id }, 201);
});
