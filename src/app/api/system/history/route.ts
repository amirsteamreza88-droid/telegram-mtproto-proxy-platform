import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { resourceMeasurements } from "@/db/schema";
import { withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";

export const GET = withAdmin(async (_a, req) => {
  const hours = Math.min(168, Math.max(1, Number(new URL(req.url).searchParams.get("hours")) || 6));
  const rows = await db.select().from(resourceMeasurements)
    .where(and(eq(resourceMeasurements.scope, "global"), gt(resourceMeasurements.ts, new Date(Date.now() - hours * 3600_000))))
    .orderBy(asc(resourceMeasurements.ts));
  return ok({ rows });
});
