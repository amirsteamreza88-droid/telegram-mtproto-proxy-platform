import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { bandwidthStats, connectionStats, resourceMeasurements } from "@/db/schema";
import { withAdmin } from "@/lib/auth";
import { ok, parseId } from "@/lib/api";

export const GET = withAdmin(async (_a, _req, ctx: { params: Promise<{ id: string }> }) => {
  const id = parseId((await ctx.params).id);
  const since = new Date(Date.now() - 6 * 3600_000);
  const [res, conns, bw] = await Promise.all([
    db.select().from(resourceMeasurements).where(and(eq(resourceMeasurements.workerId, id), gt(resourceMeasurements.ts, since))).orderBy(asc(resourceMeasurements.ts)),
    db.select().from(connectionStats).where(and(eq(connectionStats.workerId, id), gt(connectionStats.ts, since))).orderBy(asc(connectionStats.ts)),
    db.select().from(bandwidthStats).where(and(eq(bandwidthStats.workerId, id), gt(bandwidthStats.ts, since))).orderBy(asc(bandwidthStats.ts)),
  ]);
  return ok({ resources: res, connections: conns, bandwidth: bw });
});
