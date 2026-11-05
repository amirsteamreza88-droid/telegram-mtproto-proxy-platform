import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { restrictions, sponsorships, type Worker } from "@/db/schema";
import { HttpError } from "./auth";
import { mon } from "./monitor";
import { getSecret } from "./workers";

export const ok = (data: unknown, status = 200) => NextResponse.json(data, { status });

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function parseId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Invalid id");
  return n;
}

export function optInt(v: unknown, name: string, min: number, max: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  return n;
}

export async function serializeWorker(w: Worker) {
  const live = mon.live.get(w.id);
  const sp = (await db.select().from(sponsorships).where(eq(sponsorships.workerId, w.id)).limit(1))[0];
  const act = await db.select().from(restrictions).where(and(eq(restrictions.workerId, w.id), eq(restrictions.active, true)));
  let masked = "unavailable";
  try {
    const s = await getSecret(w.id);
    masked = `${s.slice(0, 4)}…${s.slice(-4)}`;
  } catch { /* no secret */ }
  let netStatus: unknown = null;
  try { netStatus = w.netStatus ? JSON.parse(w.netStatus) : null; } catch { netStatus = { error: "unparseable net_status" }; }
  return {
    id: w.id,
    name: w.name,
    netStatus,
    port: w.port,
    statsPort: w.statsPort,
    mode: w.mode,
    tlsDomain: w.tlsDomain,
    status: w.status,
    statusMessage: w.statusMessage,
    desiredState: w.desiredState,
    secretMasked: masked,
    maxConnections: w.maxConnections,
    connLimitEnabled: w.connLimitEnabled,
    downloadKbps: w.downloadKbps,
    uploadKbps: w.uploadKbps,
    bwLimitEnabled: w.bwLimitEnabled,
    autoRestart: w.autoRestart,
    restartCount: w.restartCount,
    epollStatus: w.epollStatus,
    publicIp: w.publicIp,
    trafficRxBytes: w.trafficRxBytes,
    trafficTxBytes: w.trafficTxBytes,
    configVersion: w.configVersion,
    lastVerifiedAt: w.lastVerifiedAt,
    createdAt: w.createdAt,
    sponsorState: sp?.state ?? "none",
    sponsorRequestedAt: sp?.requestedAt ?? null,
    sponsorActivatedAt: sp?.activatedAt ?? null,
    sponsorVerifiedAt: sp?.verifiedAt ?? null,
    restrictions: act.map((r) => ({ id: r.id, kind: r.kind, stage: r.stage, value: r.value, target: r.target, reason: r.reason, expiresAt: r.expiresAt })),
    live: live
      ? {
          cpuPercent: live.cpuPercent, cpuCorePercent: live.cpuCorePercent, memBytes: live.memBytes,
          connections: live.connections, uniqueIps: live.uniqueIps, attempts: live.attempts,
          rxRate: live.rxRate, txRate: live.txRate, topIps: live.topIps,
        }
      : null,
  };
}
