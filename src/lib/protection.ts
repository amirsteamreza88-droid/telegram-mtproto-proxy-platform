import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { protectionEvents, protectionState, restrictions, workers, type Worker } from "@/db/schema";
import {
  evaluate, INITIAL_STATE, pickTopConsumers, reducedLimit,
  type Decision, type ProtectionConfig, type ProtectionStateData,
} from "./core/protection-engine";
import { getProtectionConfig, logActivity } from "./settings";
import { mon } from "./monitor";
import { applyNetRules } from "./workers";
import { helper, hostAgentStatus } from "./system/host";

interface PState {
  loaded: boolean;
  state: ProtectionStateData;
  cfg: ProtectionConfig | null;
  cfgAt: number;
  busy: boolean;
  lastCpu: number | null;
  lastExpiryCheck: number;
}
const g = globalThis as typeof globalThis & { __mtpProt?: PState };
export const prot: PState = g.__mtpProt ?? (g.__mtpProt = { loaded: false, state: { ...INITIAL_STATE }, cfg: null, cfgAt: 0, busy: false, lastCpu: null, lastExpiryCheck: 0 });

export function invalidateProtectionConfig() {
  prot.cfgAt = 0;
}

async function loadState() {
  const r = await db.select().from(protectionState).where(eq(protectionState.id, 1)).limit(1);
  if (r[0]) {
    prot.state = { stage: r[0].stage, aboveSince: r[0].aboveSince, belowSince: r[0].belowSince, lastEscalationAt: r[0].lastEscalationAt, lastRecoveryAt: r[0].lastRecoveryAt };
    // timers from before a restart are stale; keep the stage (restrictions persist) but restart the clocks
    prot.state.aboveSince = null;
    prot.state.belowSince = null;
  } else {
    await db.insert(protectionState).values({ id: 1, stage: 0 }).onConflictDoNothing();
  }
  prot.loaded = true;
}

async function saveState(s: ProtectionStateData) {
  await db.insert(protectionState).values({ id: 1, ...s }).onConflictDoUpdate({
    target: protectionState.id, set: { ...s, updatedAt: sql`now()` },
  });
}

async function event(type: string, stage: number, message: string, details?: unknown) {
  await db.insert(protectionEvents).values({ type, stage, message, cpuPercent: prot.lastCpu, details: (details ?? null) as object | null });
}

function sameState(a: ProtectionStateData, b: ProtectionStateData) {
  return a.stage === b.stage && a.aboveSince === b.aboveSince && a.belowSince === b.belowSince && a.lastEscalationAt === b.lastEscalationAt && a.lastRecoveryAt === b.lastRecoveryAt;
}

/** Called every ~1s with the newest global CPU sample. */
export async function protectionTick(cpu: number) {
  if (prot.busy) return;
  prot.busy = true;
  try {
    if (!prot.loaded) await loadState();
    if (!prot.cfg || Date.now() - prot.cfgAt > 5000) {
      prot.cfg = await getProtectionConfig();
      prot.cfgAt = Date.now();
    }
    prot.lastCpu = cpu;
    const { state, decision } = evaluate(prot.state, cpu, Date.now(), prot.cfg);
    const changed = !sameState(state, prot.state);
    prot.state = state;
    if (changed) await saveState(state);
    if (decision.kind !== "none") await execute(decision, prot.cfg);
    if (Date.now() - prot.lastExpiryCheck > 10000) {
      prot.lastExpiryCheck = Date.now();
      await expireRestrictions();
    }
  } catch (e) {
    console.error("[protection]", e);
    await event("error", prot.state.stage, `Protection tick error: ${(e as Error).message}`).catch(() => {});
  } finally {
    prot.busy = false;
  }
}

function liveConsumers(list: Worker[]) {
  return list.map((w) => {
    const l = mon.live.get(w.id);
    return { id: w.id, worker: w, cpuPercent: l?.cpuPercent ?? null, txRate: l?.txRate ?? 0, rxRate: l?.rxRate ?? 0, topIps: l?.topIps ?? [] };
  });
}

async function hasActive(workerId: number | null, kind: string, stage: number, target?: string) {
  const conds = [eq(restrictions.kind, kind), eq(restrictions.stage, stage), eq(restrictions.active, true)];
  if (workerId != null) conds.push(eq(restrictions.workerId, workerId));
  if (target) conds.push(eq(restrictions.target, target));
  const r = await db.select({ id: restrictions.id }).from(restrictions).where(and(...conds)).limit(1);
  return !!r[0];
}

async function execute(d: Decision, cfg: ProtectionConfig) {
  const agent = await hostAgentStatus();
  if (d.kind === "escalate") {
    const list = await db.select().from(workers).where(eq(workers.status, "active"));
    const top = pickTopConsumers(liveConsumers(list), cfg.topWorkers);
    if (d.from === 0) {
      await event("trigger", 1, `CPU ≥ ${cfg.triggerPercent}% for ${cfg.triggerSeconds}s – protection triggered (stage 1: analysis)`, {
        topWorkers: top.map((t) => ({ id: t.id, name: t.worker.name, cpuPercent: t.cpuPercent })),
      });
    } else {
      await event("escalate", d.to, `Overload persists – escalating to stage ${d.to}`);
    }
    if (!top.length) {
      await event("restriction", d.to, "No worker has measurable CPU consumption (cgroup accounting); no worker restrictions applied. Load is caused by other processes.");
      return;
    }
    if (!agent.ok) {
      await event("error", d.to, `Cannot apply restrictions: ${agent.reason}`);
      return;
    }
    const affected = new Set<number>();
    for (const t of top) {
      const w = t.worker;
      if (d.to === 2 || d.to === 4) {
        const factor = d.to === 2 ? cfg.stage2BandwidthFactor : cfg.stage4BandwidthFactor;
        if (!(await hasActive(w.id, "bandwidth", d.to))) {
          const down = reducedLimit(w.bwLimitEnabled ? w.downloadKbps : null, (t.txRate * 8) / 1000, factor, cfg.stage2MinKbps);
          const up = reducedLimit(w.bwLimitEnabled ? w.uploadKbps : null, (t.rxRate * 8) / 1000, factor, cfg.stage2MinKbps);
          await db.insert(restrictions).values({
            workerId: w.id, kind: "bandwidth", stage: d.to, value: { downKbps: down, upKbps: up },
            original: { downloadKbps: w.downloadKbps, uploadKbps: w.uploadKbps, bwLimitEnabled: w.bwLimitEnabled },
            reason: `Stage ${d.to}: worker CPU ${t.cpuPercent?.toFixed(1)}%`,
          });
          affected.add(w.id);
          await event("restriction", d.to, `Bandwidth on worker #${w.id} (${w.name}) temporarily limited to ↓${down} / ↑${up} kbit/s`, { workerId: w.id, down, up });
        }
      }
      if (d.to === 3) {
        if (!(await hasActive(w.id, "conn_per_ip", 3))) {
          await db.insert(restrictions).values({ workerId: w.id, kind: "conn_per_ip", stage: 3, value: { limit: cfg.stage3PerIpConnLimit }, reason: "Stage 3: excessive connections" });
          affected.add(w.id);
          await event("restriction", 3, `Worker #${w.id}: new connections limited to ${cfg.stage3PerIpConnLimit} concurrent per source IP (existing connections kept)`, { workerId: w.id });
        }
        if (cfg.stage3IpBlockEnabled) {
          for (const ip of t.topIps.filter((x) => x.count >= cfg.stage3IpBlockThreshold)) {
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.ip) || (await hasActive(w.id, "ip_block", 3, ip.ip))) continue;
            await db.insert(restrictions).values({
              workerId: w.id, kind: "ip_block", stage: 3, target: ip.ip, value: { connections: ip.count },
              expiresAt: new Date(Date.now() + cfg.stage3IpBlockMinutes * 60000),
              reason: `Source IP held ${ip.count} concurrent connections (threshold ${cfg.stage3IpBlockThreshold})`,
            });
            affected.add(w.id);
            await event("restriction", 3, `Temporary block of source IP ${ip.ip} on worker #${w.id} for ${cfg.stage3IpBlockMinutes} min (${ip.count} concurrent connections; may be a shared/NAT address)`, { workerId: w.id, ip: ip.ip });
          }
        }
      }
      if (d.to === 4 && !(await hasActive(w.id, "cpu_quota", 4))) {
        try {
          await helper(["cpuquota", w.id, cfg.stage4CpuQuotaPercent]);
          await db.insert(restrictions).values({ workerId: w.id, kind: "cpu_quota", stage: 4, value: { percent: cfg.stage4CpuQuotaPercent }, reason: "Stage 4 emergency" });
          await event("restriction", 4, `Emergency: worker #${w.id} CPUQuota=${cfg.stage4CpuQuotaPercent}% (cgroup)`, { workerId: w.id });
        } catch (e) {
          await event("error", 4, `Failed to apply CPUQuota on worker #${w.id}: ${(e as Error).message}`);
        }
      }
    }
    await reapply([...affected]);
    await logActivity("protection", "protection.escalate", null, { to: d.to, workers: top.map((t) => t.id) }, "warn");
  } else if (d.kind === "recover" || d.kind === "restore_all") {
    const minStage = d.kind === "recover" ? (d.to === 0 ? 0 : d.to + 1) : 0;
    const lifted = await liftWhere(sql`${restrictions.stage} >= ${minStage}`);
    const msg = d.kind === "restore_all"
      ? "Protection disabled – all automatic restrictions lifted"
      : d.to === 0 ? "CPU recovered – all restrictions lifted, original limits restored" : `CPU recovering – stage ${d.from} restrictions lifted (now stage ${d.to})`;
    await event(d.kind === "recover" ? "recover" : "restore", d.kind === "recover" ? d.to : 0, msg, { lifted });
    await logActivity("protection", "protection.recover", null, { from: d.from, lifted });
  }
}

/** Lift active restrictions matching cond and re-apply effective limits for affected workers. */
/**
 * Remove a worker's CPUQuota through the host helper and CONFIRM via systemd that
 * it is actually gone. Returns true only when systemd reports no quota.
 * Exported for tests.
 */
export async function removeCpuQuotaVerified(workerId: number): Promise<{ ok: boolean; detail: string }> {
  await helper(["cpuquota", workerId, "off"]);
  const check = (await helper(["cpuquota-check", workerId])).trim();
  if (check === "off") return { ok: true, detail: "CPUQuota removed and confirmed via systemd" };
  return { ok: false, detail: `systemd still reports CPUQuota=${check}` };
}

/**
 * Lift active restrictions matching cond. CPUQuota restrictions are deactivated in
 * the database ONLY AFTER systemd confirms the quota is gone; on failure the row
 * stays active (so it is retried on the next recovery tick / manual restore) and an
 * error event is recorded. Returns the number of restrictions actually lifted.
 */
export async function liftWhere(cond: ReturnType<typeof sql>) {
  const rows = await db.select().from(restrictions).where(and(eq(restrictions.active, true), cond));
  if (!rows.length) return 0;
  const liftedIds: number[] = [];
  const affected = new Set<number>();
  for (const r of rows) {
    if (r.kind === "cpu_quota" && r.workerId) {
      try {
        const res = await removeCpuQuotaVerified(r.workerId);
        if (!res.ok) {
          await event("error", r.stage, `CPUQuota removal NOT confirmed for worker #${r.workerId} – restriction stays active and will be retried. ${res.detail}`);
          continue; // keep active in DB
        }
      } catch (e) {
        await event("error", r.stage, `CPUQuota removal failed for worker #${r.workerId} – restriction stays active and will be retried. ${(e as Error).message}`);
        continue;
      }
    }
    liftedIds.push(r.id);
    if (r.workerId) affected.add(r.workerId);
  }
  if (liftedIds.length) {
    await db.update(restrictions).set({ active: false, liftedAt: new Date() }).where(inArray(restrictions.id, liftedIds));
  }
  await reapply([...affected]);
  return liftedIds.length;
}

async function reapply(ids: number[]) {
  if (!ids.length) return;
  const list = await db.select().from(workers).where(inArray(workers.id, ids));
  for (const w of list) {
    try {
      await applyNetRules(w);
    } catch (e) {
      await event("error", prot.state.stage, `Failed to apply network rules for worker #${w.id}: ${(e as Error).message}`);
    }
  }
}

async function expireRestrictions() {
  const n = await liftWhere(sql`${restrictions.expiresAt} IS NOT NULL AND ${restrictions.expiresAt} < now()`);
  if (n) await event("recover", prot.state.stage, `${n} temporary restriction(s) expired and were lifted`);
}

/** Manual restore: lift every active restriction for one worker (or all). */
export async function manualRestore(workerId: number | null, actor: string) {
  const n = await liftWhere(workerId != null ? sql`${restrictions.workerId} = ${workerId}` : sql`true`);
  if (workerId == null) {
    prot.state = { ...INITIAL_STATE };
    await saveState(prot.state);
  }
  await event("manual", prot.state.stage, `${actor} manually restored ${workerId != null ? `worker #${workerId}` : "all workers"} (${n} restriction(s) lifted)`);
  return n;
}

export async function cleanupOldEvents() {
  await db.delete(protectionEvents).where(lt(protectionEvents.ts, new Date(Date.now() - 90 * 86400000)));
}
