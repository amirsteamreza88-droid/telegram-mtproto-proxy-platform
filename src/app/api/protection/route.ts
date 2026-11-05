import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { protectionEvents, restrictions, workers } from "@/db/schema";
import { HttpError, withAdmin } from "@/lib/auth";
import { ok, readJson } from "@/lib/api";
import { DEFAULT_PROTECTION_CONFIG, validateConfig, type ProtectionConfig } from "@/lib/core/protection-engine";
import { mon } from "@/lib/monitor";
import { invalidateProtectionConfig, prot } from "@/lib/protection";
import { getProtectionConfig, logActivity, setProtectionConfig } from "@/lib/settings";

export const GET = withAdmin(async () => {
  const cfg = await getProtectionConfig();
  const act = await db.select({ r: restrictions, name: workers.name }).from(restrictions)
    .leftJoin(workers, eq(workers.id, restrictions.workerId)).where(eq(restrictions.active, true)).orderBy(desc(restrictions.id));
  const events = await db.select().from(protectionEvents).orderBy(desc(protectionEvents.ts)).limit(200);
  const now = Date.now();
  const s = prot.state;
  const belowMs = s.belowSince ? now - s.belowSince : 0;
  return ok({
    config: cfg,
    defaults: DEFAULT_PROTECTION_CONFIG,
    state: {
      ...s,
      cpu: prot.lastCpu,
      secondsAbove: s.aboveSince ? (now - s.aboveSince) / 1000 : 0,
      secondsBelow: belowMs / 1000,
      recoveryProgress: s.stage > 0 ? Math.min(1, belowMs / (cfg.recoverySeconds * 1000)) : null,
    },
    cpuHistory: mon.history.slice(-120).map((h) => ({ ts: h.ts, cpu: h.cpu })),
    restrictions: act.map((x) => ({ ...x.r, workerName: x.name })),
    events,
  });
});

export const PATCH = withAdmin(async (admin, req) => {
  const b = await readJson<Partial<ProtectionConfig>>(req);
  const cur = await getProtectionConfig();
  const next: ProtectionConfig = { ...cur };
  for (const k of Object.keys(DEFAULT_PROTECTION_CONFIG) as (keyof ProtectionConfig)[]) {
    if (b[k] === undefined) continue;
    const def = DEFAULT_PROTECTION_CONFIG[k];
    if (typeof def === "boolean") (next as unknown as Record<string, unknown>)[k] = !!b[k];
    else {
      const n = Number(b[k]);
      if (!Number.isFinite(n)) throw new HttpError(400, `${k} must be a number`);
      (next as unknown as Record<string, unknown>)[k] = n;
    }
  }
  const err = validateConfig(next);
  if (err) throw new HttpError(400, err);
  await setProtectionConfig(next);
  invalidateProtectionConfig();
  await logActivity(admin.username, "protection.config_updated", null, next);
  return ok({ config: next });
});
