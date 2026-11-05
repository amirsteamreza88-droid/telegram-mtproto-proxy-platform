import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { protectionEvents, restrictions, workers } from "@/db/schema";
import { withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";
import { mon, systemSnapshot } from "@/lib/monitor";
import { prot } from "@/lib/protection";
import { getProtectionConfig } from "@/lib/settings";
import { hostAgentStatus } from "@/lib/system/host";

export const GET = withAdmin(async () => {
  const list = await db.select().from(workers);
  const active = list.filter((w) => w.status === "active").length;
  let connections: number | null = null;
  for (const w of list) {
    const c = mon.live.get(w.id)?.connections;
    if (c != null) connections = (connections ?? 0) + c;
  }
  const traffic = list.reduce((a, w) => a + w.trafficRxBytes + w.trafficTxBytes, 0);
  const cfg = await getProtectionConfig();
  const activeRestrictions = await db.select().from(restrictions).where(eq(restrictions.active, true));
  const events = await db.select().from(protectionEvents).orderBy(desc(protectionEvents.ts)).limit(5);
  return ok({
    system: systemSnapshot(),
    workers: {
      total: list.length,
      active,
      offline: list.filter((w) => ["stopped", "failed", "error"].includes(w.status)).length,
      pending: list.filter((w) => ["pending", "deploying"].includes(w.status)).length,
    },
    connections,
    traffic,
    protection: {
      enabled: cfg.enabled, stage: prot.state.stage, aboveSince: prot.state.aboveSince, belowSince: prot.state.belowSince,
      triggerPercent: cfg.triggerPercent, activeRestrictions: activeRestrictions.length, recentEvents: events,
    },
    hostAgent: await hostAgentStatus(),
  });
});
