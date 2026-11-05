import fs from "node:fs";
import { db } from "@/db";
import { backups } from "@/db/schema";
import { HttpError, withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";
import { safeBackupPath, validateBackup } from "@/lib/backup";
import { sha256 } from "@/lib/crypto";
import { logActivity } from "@/lib/settings";

export const POST = withAdmin(async (admin, req) => {
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length < 40 || buf.length > 200 * 1024 * 1024) throw new HttpError(400, "Invalid backup size");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const filename = `mtpanel-uploaded-${stamp}-${Math.floor(Math.random() * 1000)}.mtpb`;
  fs.writeFileSync(safeBackupPath(filename), buf, { mode: 0o600 });
  const [row] = await db.insert(backups).values({ filename, kind: "uploaded", status: "ready", sizeBytes: buf.length, sha256: sha256(buf) }).returning();
  try {
    const v = await validateBackup(row.id);
    await logActivity(admin.username, "backup.uploaded", filename);
    return ok({ backup: row, validation: v });
  } catch (e) {
    await db.update(backups).set({ status: "failed", error: (e as Error).message }).where((await import("drizzle-orm")).eq(backups.id, row.id));
    throw new HttpError(400, `Backup rejected: ${(e as Error).message} (backups can only be restored with the same APP_SECRET_KEY)`);
  }
});
