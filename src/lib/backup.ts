import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { desc, eq, and } from "drizzle-orm";
import { db, pool } from "@/db";
import { backups } from "@/db/schema";
import { dataDir, decryptBuffer, encryptBuffer, sha256 } from "./crypto";
import { getGeneral, logActivity } from "./settings";
import type { Progress } from "./workers";

// Configuration tables included in backups (order = restore order).
// High-volume time series (stats/measurements), sessions and jobs are excluded.
export const BACKUP_TABLES = [
  "admins", "app_settings", "workers", "proxy_secrets", "sponsorships", "worker_configs",
  "restrictions", "protection_state", "protection_events", "activity_logs",
] as const;
const SERIAL_TABLES = ["admins", "workers", "proxy_secrets", "worker_configs", "restrictions", "protection_events", "activity_logs"];

export function backupDir(): string {
  const d = process.env.BACKUP_DIR || path.join(dataDir(), "backups");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function safeBackupPath(filename: string): string {
  if (!/^mtpanel-[a-z-]+-\d{8}T\d{6}Z(-\d+)?\.mtpb$/.test(filename)) throw new Error("Invalid backup filename");
  return path.join(backupDir(), filename);
}

export async function createBackup(kind: string, progress?: Progress) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const filename = `mtpanel-${kind}-${stamp}-${Math.floor(Math.random() * 1000)}.mtpb`;
  const [row] = await db.insert(backups).values({ filename, kind, status: "creating" }).returning();
  try {
    await progress?.(10, "Exporting database tables");
    const data: Record<string, unknown[]> = {};
    for (const t of BACKUP_TABLES) {
      const r = await pool.query(`SELECT * FROM "${t}"`);
      data[t] = r.rows;
    }
    await progress?.(60, "Compressing and encrypting");
    const doc = { format: "mtpanel-backup", version: 1, createdAt: new Date().toISOString(), tables: data };
    const enc = encryptBuffer(zlib.gzipSync(Buffer.from(JSON.stringify(doc))));
    const file = safeBackupPath(filename);
    fs.writeFileSync(file, enc, { mode: 0o600 });
    const hash = sha256(enc);
    await progress?.(85, "Validating backup");
    validateBuffer(enc);
    await db.update(backups).set({ status: "ready", sizeBytes: enc.length, sha256: hash, validatedAt: new Date() }).where(eq(backups.id, row.id));
    await logActivity("system", "backup.created", filename, { kind, size: enc.length });
    if (kind === "scheduled") await prune();
    return { id: row.id, filename };
  } catch (e) {
    await db.update(backups).set({ status: "failed", error: (e as Error).message }).where(eq(backups.id, row.id));
    throw e;
  }
}

function validateBuffer(buf: Buffer) {
  const json = JSON.parse(zlib.gunzipSync(decryptBuffer(buf)).toString("utf8"));
  if (json.format !== "mtpanel-backup" || json.version !== 1) throw new Error("Unknown backup format");
  for (const t of BACKUP_TABLES) if (!Array.isArray(json.tables?.[t])) throw new Error(`Backup missing table ${t}`);
  return json as { createdAt: string; tables: Record<string, unknown[]> };
}

export async function validateBackup(id: number) {
  const [b] = await db.select().from(backups).where(eq(backups.id, id)).limit(1);
  if (!b) throw new Error("Backup not found");
  const buf = fs.readFileSync(safeBackupPath(b.filename));
  if (b.sha256 && sha256(buf) !== b.sha256) throw new Error("Checksum mismatch – file was modified or corrupted");
  const doc = validateBuffer(buf);
  await db.update(backups).set({ validatedAt: new Date() }).where(eq(backups.id, id));
  return { createdAt: doc.createdAt, counts: Object.fromEntries(Object.entries(doc.tables).map(([k, v]) => [k, v.length])) };
}

/** Restore DB configuration from a backup. Caller re-syncs host services afterwards. */
export async function restoreBackup(id: number, progress: Progress) {
  const [b] = await db.select().from(backups).where(eq(backups.id, id)).limit(1);
  if (!b) throw new Error("Backup not found");
  await progress(5, "Validating backup");
  const buf = fs.readFileSync(safeBackupPath(b.filename));
  if (b.sha256 && sha256(buf) !== b.sha256) throw new Error("Checksum mismatch");
  const doc = validateBuffer(buf);
  await progress(15, "Creating safety backup of current state");
  await createBackup("pre-restore");
  await progress(35, "Restoring tables");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE ${[...BACKUP_TABLES].reverse().map((t) => `"${t}"`).join(", ")}, "sessions" CASCADE`);
    for (const t of BACKUP_TABLES) {
      const rows = doc.tables[t];
      if (rows.length) {
        await client.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(null::"${t}", $1::json)`, [JSON.stringify(rows)]);
      }
    }
    for (const t of SERIAL_TABLES) {
      await client.query(`SELECT setval(pg_get_serial_sequence('"${t}"','id'), GREATEST(COALESCE((SELECT MAX(id) FROM "${t}"),0),1))`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw new Error(`Restore failed, database unchanged: ${(e as Error).message}`);
  } finally {
    client.release();
  }
  await logActivity("system", "backup.restored", b.filename);
  await progress(70, "Database restored");
}

async function prune() {
  const keep = (await getGeneral()).backupKeep;
  const list = await db.select().from(backups).where(and(eq(backups.kind, "scheduled"))).orderBy(desc(backups.createdAt));
  for (const b of list.slice(keep)) {
    try { fs.unlinkSync(safeBackupPath(b.filename)); } catch { /* already gone */ }
    await db.delete(backups).where(eq(backups.id, b.id));
  }
}

export async function lastScheduledBackupAt(): Promise<number> {
  const r = await db.select().from(backups).where(eq(backups.kind, "scheduled")).orderBy(desc(backups.createdAt)).limit(1);
  return r[0] ? r[0].createdAt.getTime() : 0;
}
