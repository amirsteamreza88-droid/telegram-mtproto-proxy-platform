import { HttpError, withAdmin } from "@/lib/auth";
import { ok, readJson } from "@/lib/api";
import { DEFAULT_GENERAL, getGeneral, logActivity, setGeneral, type GeneralSettings } from "@/lib/settings";
import { resolvePublicHost } from "@/lib/workers";

export const GET = withAdmin(async () => ok({ settings: await getGeneral(), detectedPublicIp: await resolvePublicHost() }));

export const PATCH = withAdmin(async (admin, req) => {
  const b = await readJson<Partial<GeneralSettings>>(req);
  const cur = await getGeneral();
  const next: GeneralSettings = { ...cur };
  if (b.publicHost !== undefined) {
    const h = String(b.publicHost).trim();
    if (h && !/^[a-zA-Z0-9.:-]{1,253}$/.test(h)) throw new HttpError(400, "Invalid public host");
    next.publicHost = h;
  }
  if (b.defaultFakeTlsDomain !== undefined) next.defaultFakeTlsDomain = String(b.defaultFakeTlsDomain).trim().toLowerCase();
  if (b.reservedPorts !== undefined) {
    const arr = (Array.isArray(b.reservedPorts) ? b.reservedPorts : []).map(Number);
    if (arr.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new HttpError(400, "Invalid reserved ports");
    next.reservedPorts = [...new Set([...arr, ...DEFAULT_GENERAL.reservedPorts.filter((p) => p === 22)])];
  }
  for (const k of ["healthAutoRestart", "backupEnabled"] as const) if (b[k] !== undefined) next[k] = !!b[k];
  const ranges: [keyof GeneralSettings, number, number][] = [["maxAutoRestartsPerHour", 0, 60], ["statsRetentionDays", 1, 365], ["backupIntervalHours", 1, 720], ["backupKeep", 1, 365]];
  for (const [k, min, max] of ranges) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${k} must be ${min}..${max}`);
    (next as unknown as Record<string, number>)[k] = n;
  }
  await setGeneral(next);
  await logActivity(admin.username, "settings.updated", null, next);
  return ok({ settings: next });
});
