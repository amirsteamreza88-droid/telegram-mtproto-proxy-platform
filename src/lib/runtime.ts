import { eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { workers } from "@/db/schema";
import { enqueue, registerJob, startJobRunner } from "./jobs";
import { mon, persist, sampleFast, sampleSlow } from "./monitor";
import { cleanupOldEvents, protectionTick } from "./protection";
import {
  applyNetRules, applyWorkerUpdate, deleteWorker, deployWorker, loadWorker, restartWorker,
  startWorker, stopWorker, tcpProbe,
} from "./workers";
import { createBackup, lastScheduledBackupAt, restoreBackup } from "./backup";
import { getGeneral, logActivity } from "./settings";
import { helper, hostAgentStatus, unitStatus } from "./system/host";
import type { Progress } from "./workers";

const num = (p: Record<string, unknown>, k: string) => {
  const v = Number(p[k]);
  if (!Number.isInteger(v) || v <= 0) throw new Error(`Invalid ${k}`);
  return v;
};

export async function hostSync(progress: Progress) {
  await progress(5, "Reading host state");
  const list = await db.select().from(workers);
  const ids = new Set(list.map((w) => w.id));
  const out = await helper(["list"]);
  const hostIds = out.split(/\s+/).filter(Boolean).map(Number);
  for (const hid of hostIds) {
    if (!ids.has(hid)) await helper(["remove", hid]);
  }
  let i = 0;
  const errors: string[] = [];
  for (const w of list) {
    i++;
    const p: Progress = (pct, step) => progress(10 + ((i - 1 + pct / 100) / list.length) * 85, `#${w.id}: ${step}`);
    try {
      if (w.desiredState === "running") await deployWorker(w.id, p);
      else await stopWorker(w.id, p);
    } catch (e) {
      errors.push(`#${w.id}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  if (errors.length) throw new Error(`Host sync finished with errors:\n${errors.join("\n")}`);
  await progress(100, "Host in sync with database");
}

function registerAll() {
  registerJob("worker.deploy", (p, pr) => deployWorker(num(p, "workerId"), pr));
  registerJob("worker.start", (p, pr) => startWorker(num(p, "workerId"), pr));
  registerJob("worker.stop", (p, pr) => stopWorker(num(p, "workerId"), pr));
  registerJob("worker.restart", (p, pr) => restartWorker(num(p, "workerId"), pr));
  registerJob("worker.delete", (p, pr) => deleteWorker(num(p, "workerId"), pr));
  registerJob("worker.update", (p, pr) => applyWorkerUpdate(num(p, "workerId"), p as never, pr));
  registerJob("worker.net", async (p, pr) => {
    await applyNetRules(await loadWorker(num(p, "workerId")));
    await pr(100, "Network rules applied");
  });
  registerJob("backup.create", (p, pr) => createBackup(String(p.kind || "manual"), pr));
  registerJob("backup.restore", async (p, pr) => {
    await restoreBackup(num(p, "backupId"), pr);
    if ((await hostAgentStatus(true)).ok) await hostSync((pct, s) => pr(70 + pct * 0.3, s));
    else await pr(100, "Database restored (host agent unavailable – services not re-synced)");
  });
  registerJob("host.sync", (_p, pr) => hostSync(pr));
}

// ---------- health monitor ----------
const health = new Map<number, { failures: number; nRestarts: number }>();

async function healthTick() {
  const gen = await getGeneral();
  const list = await db.select().from(workers).where(inArray(workers.status, ["active", "error"]));
  for (const w of list) {
    if (w.desiredState !== "running") continue;
    const st = await unitStatus(w.id);
    if (!st.available) continue; // no systemd (dev) – nothing to measure
    const h = health.get(w.id) || { failures: 0, nRestarts: st.nRestarts };
    if (st.nRestarts > h.nRestarts) {
      await logActivity("health", "worker.unexpected_restart", `worker:${w.id}`, { nRestarts: st.nRestarts }, "warn");
      await db.update(workers).set({ restartCount: sql`${workers.restartCount} + ${st.nRestarts - h.nRestarts}` }).where(eq(workers.id, w.id));
    }
    h.nRestarts = st.nRestarts;
    const ok = st.activeState === "active" && (await tcpProbe(w.port, "127.0.0.1", 2000));
    if (ok) {
      h.failures = 0;
      if (w.status !== "active") {
        await db.update(workers).set({ status: "active", statusMessage: "Recovered (verified by health monitor)", lastVerifiedAt: new Date() }).where(eq(workers.id, w.id));
        await logActivity("health", "worker.recovered", `worker:${w.id}`);
      } else {
        await db.update(workers).set({ lastVerifiedAt: new Date() }).where(eq(workers.id, w.id));
      }
    } else {
      h.failures++;
      // systemd restarts crashed units itself (bounded by StartLimitBurst); act after 3 consecutive failures (~15s)
      if (h.failures === 3) {
        const reason = st.activeState !== "active" ? `service ${st.activeState}/${st.subState}` : `port ${w.port} not accepting connections`;
        await db.update(workers).set({ status: "error", statusMessage: `Health check failed: ${reason}` }).where(eq(workers.id, w.id));
        await logActivity("health", "worker.unhealthy", `worker:${w.id}`, { reason }, "error");
        const windowStart = w.autoRestartWindowStart?.getTime() ?? 0;
        const inWindow = Date.now() - windowStart < 3600_000 ? w.autoRestartsInWindow : 0;
        if (gen.healthAutoRestart && w.autoRestart && inWindow < gen.maxAutoRestartsPerHour) {
          await db.update(workers).set({
            autoRestartsInWindow: inWindow + 1,
            autoRestartWindowStart: inWindow === 0 ? new Date() : w.autoRestartWindowStart,
          }).where(eq(workers.id, w.id));
          await enqueue("worker.restart", { workerId: w.id, reason: "health" }, { key: `restart:${w.id}` });
          await logActivity("health", "worker.auto_restart", `worker:${w.id}`, { attempt: inWindow + 1 }, "warn");
        } else {
          await db.update(workers).set({ statusMessage: `Health check failed: ${reason}. Auto-restart budget exhausted (${gen.maxAutoRestartsPerHour}/h) – manual action required.` }).where(eq(workers.id, w.id));
        }
      }
    }
    health.set(w.id, h);
  }
}

// ---------- loops ----------
const g = globalThis as typeof globalThis & { __mtpRuntime?: boolean };

export async function startRuntime() {
  if (g.__mtpRuntime) return;
  g.__mtpRuntime = true;
  // wait for DB + schema
  for (let i = 0; i < 60; i++) {
    try {
      await pool.query("SELECT 1 FROM workers LIMIT 1");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  registerAll();
  await startJobRunner().catch((e) => console.error("[runtime] job runner", e));

  let ids: number[] = [];
  let slowList: { id: number; port: number; trafficRxBytes: number; trafficTxBytes: number }[] = [];
  const refresh = async () => {
    slowList = await db.select({ id: workers.id, port: workers.port, trafficRxBytes: workers.trafficRxBytes, trafficTxBytes: workers.trafficTxBytes }).from(workers);
    ids = slowList.map((w) => w.id);
  };
  await refresh().catch(() => {});

  setInterval(() => {
    const s = sampleFast(ids);
    if (s) void protectionTick(s.cpu);
  }, 1000);

  let slowBusy = false;
  setInterval(async () => {
    if (slowBusy) return;
    slowBusy = true;
    try {
      await refresh();
      await sampleSlow(slowList);
      await persist(slowList);
      await healthTick();
    } catch (e) {
      console.error("[runtime] slow loop", e);
    } finally {
      slowBusy = false;
    }
  }, 5000);

  setInterval(async () => {
    try {
      const gen = await getGeneral();
      if (gen.backupEnabled && Date.now() - (await lastScheduledBackupAt()) > gen.backupIntervalHours * 3600_000) {
        await enqueue("backup.create", { kind: "scheduled" }, { key: "backup:scheduled" });
      }
      await cleanupOldEvents();
    } catch (e) {
      console.error("[runtime] scheduler", e);
    }
  }, 60_000);

  console.log("[runtime] monitor, protection, health, jobs and scheduler started", { workers: ids.length, history: mon.history.length });
}
