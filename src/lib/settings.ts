import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLogs, appSettings } from "@/db/schema";
import { DEFAULT_PROTECTION_CONFIG, type ProtectionConfig } from "./core/protection-engine";

export interface GeneralSettings {
  publicHost: string; // empty = auto-detect public IP
  defaultFakeTlsDomain: string;
  reservedPorts: number[];
  healthAutoRestart: boolean;
  maxAutoRestartsPerHour: number;
  statsRetentionDays: number;
  backupEnabled: boolean;
  backupIntervalHours: number;
  backupKeep: number;
}

export const DEFAULT_GENERAL: GeneralSettings = {
  publicHost: "",
  defaultFakeTlsDomain: "www.cloudflare.com",
  reservedPorts: [22, 80, 5432, Number(process.env.PANEL_PUBLIC_PORT || 8443), Number(process.env.PORT || 3000)],
  healthAutoRestart: true,
  maxAutoRestartsPerHour: 5,
  statsRetentionDays: 7,
  backupEnabled: true,
  backupIntervalHours: 24,
  backupKeep: 14,
};

async function getRaw<T>(key: string, def: T): Promise<T> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (!rows[0]) return def;
  return { ...def, ...(rows[0].value as object) } as T;
}

async function setRaw(key: string, value: unknown) {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: sql`now()` } });
}

export const getGeneral = () => getRaw<GeneralSettings>("general", DEFAULT_GENERAL);
export const setGeneral = (v: GeneralSettings) => setRaw("general", v);
export const getProtectionConfig = () => getRaw<ProtectionConfig>("protection", DEFAULT_PROTECTION_CONFIG);
export const setProtectionConfig = (v: ProtectionConfig) => setRaw("protection", v);
export const getMeta = <T>(key: string, def: T) => getRaw<T>(`meta:${key}`, def);
export const setMeta = (key: string, v: unknown) => setRaw(`meta:${key}`, v);

export async function logActivity(
  actor: string,
  action: string,
  target?: string | null,
  details?: unknown,
  level: "info" | "warn" | "error" = "info",
  ip?: string,
) {
  try {
    await db.insert(activityLogs).values({
      actor,
      action,
      target: target ?? null,
      details: (details ?? null) as object | null,
      level,
      ip: ip ?? null,
    });
  } catch (e) {
    console.error("[activity] failed to log", action, e);
  }
}
