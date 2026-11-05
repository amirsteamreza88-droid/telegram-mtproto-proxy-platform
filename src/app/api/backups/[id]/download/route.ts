import fs from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { backups } from "@/db/schema";
import { HttpError, withAdmin } from "@/lib/auth";
import { parseId } from "@/lib/api";
import { safeBackupPath } from "@/lib/backup";
import { logActivity } from "@/lib/settings";

export const GET = withAdmin(async (admin, _req, ctx: { params: Promise<{ id: string }> }) => {
  const id = parseId((await ctx.params).id);
  const [b] = await db.select().from(backups).where(eq(backups.id, id));
  if (!b || b.status !== "ready") throw new HttpError(404, "Backup not available");
  const buf = fs.readFileSync(safeBackupPath(b.filename));
  await logActivity(admin.username, "backup.downloaded", b.filename);
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${b.filename}"` },
  });
});
