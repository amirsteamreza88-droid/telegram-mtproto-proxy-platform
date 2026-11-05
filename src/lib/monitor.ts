import os from "node:os";
import { db } from "@/db";
import { bandwidthStats, connectionStats, resourceMeasurements, workers } from "@/db/schema";
import { sql, lt, eq } from "drizzle-orm";
import {
  connectionsOnPort, cpuPercent, readCpuTimes, readDisk, readLoad, readMem, readNet,
  readTcpSockets, readUptime, readWorkerCgroup, type CpuTimes,
} from "./system/metrics";
import { helper, hostAgentStatus } from "./system/host";
import { getGeneral } from "./settings";

export interface GlobalSample {
  ts: number;
  cpu: number;
  cores: number[];
}

export interface WorkerLive {
  cpuPercent: number | null; // % of total machine capacity (cgroup measured)
  cpuCorePercent: number | null; // % of a single core
  memBytes: number | null;
  connections: number | null;
  uniqueIps: number | null;
  topIps: { ip: string; count: number }[];
  rxRate: number | null; // bytes/s from clients (client upload) – tc ifb class
  txRate: number | null; // bytes/s to clients (client download) – tc egress class
  attempts: number | null; // NEW TCP connections counted by iptables since rules were (re)built
  updatedAt: number;
}

interface MonitorState {
  history: GlobalSample[];
  prevCpu: { all: CpuTimes; cores: CpuTimes[] } | null;
  prevWorkerCpu: Map<number, { usec: number; at: number }>;
  prevTc: Map<string, { bytes: number; at: number }>;
  prevNet: { rx: number; tx: number; at: number } | null;
  netRate: { rx: number; tx: number };
  live: Map<number, WorkerLive>;
  lastPersist: number;
}

const g = globalThis as typeof globalThis & { __mtpMonitor?: MonitorState };
export const mon: MonitorState =
  g.__mtpMonitor ??
  (g.__mtpMonitor = {
    history: [],
    prevCpu: null,
    prevWorkerCpu: new Map(),
    prevTc: new Map(),
    prevNet: null,
    netRate: { rx: 0, tx: 0 },
    live: new Map(),
    lastPersist: 0,
  });

function liveFor(id: number): WorkerLive {
  let l = mon.live.get(id);
  if (!l) {
    l = { cpuPercent: null, cpuCorePercent: null, memBytes: null, connections: null, uniqueIps: null, topIps: [], rxRate: null, txRate: null, attempts: null, updatedAt: 0 };
    mon.live.set(id, l);
  }
  return l;
}

/** ~1s tick: global CPU + per-worker cgroup CPU/RAM. Returns the CPU sample. */
export function sampleFast(workerIds: number[]): GlobalSample | null {
  const cur = readCpuTimes();
  if (!cur) return null;
  const now = Date.now();
  let sample: GlobalSample | null = null;
  if (mon.prevCpu) {
    sample = {
      ts: now,
      cpu: cpuPercent(mon.prevCpu.all, cur.all),
      cores: cur.cores.map((c, i) => (mon.prevCpu!.cores[i] ? cpuPercent(mon.prevCpu!.cores[i], c) : 0)),
    };
    mon.history.push(sample);
    if (mon.history.length > 600) mon.history.shift();
  }
  mon.prevCpu = cur;

  const ncpu = os.cpus().length || 1;
  for (const id of workerIds) {
    const cg = readWorkerCgroup(id);
    const l = liveFor(id);
    if (!cg) {
      l.cpuPercent = null; l.cpuCorePercent = null; l.memBytes = null;
      mon.prevWorkerCpu.delete(id);
      continue;
    }
    const prev = mon.prevWorkerCpu.get(id);
    if (prev && now > prev.at && cg.cpuUsec >= prev.usec) {
      const core = ((cg.cpuUsec - prev.usec) / ((now - prev.at) * 1000)) * 100;
      l.cpuCorePercent = core;
      l.cpuPercent = core / ncpu;
    }
    l.memBytes = cg.memBytes;
    l.updatedAt = now;
    mon.prevWorkerCpu.set(id, { usec: cg.cpuUsec, at: now });
  }

  const net = readNet();
  if (net) {
    if (mon.prevNet && now > mon.prevNet.at) {
      const dt = (now - mon.prevNet.at) / 1000;
      mon.netRate = { rx: Math.max(0, (net.rx - mon.prevNet.rx) / dt), tx: Math.max(0, (net.tx - mon.prevNet.tx) / dt) };
    }
    mon.prevNet = { rx: net.rx, tx: net.tx, at: now };
  }
  return sample;
}

/** ~5s tick: connections, per-worker bandwidth (tc), connection attempts (iptables). */
export async function sampleSlow(list: { id: number; port: number; trafficRxBytes: number; trafficTxBytes: number }[]) {
  const socks = readTcpSockets();
  for (const w of list) {
    const l = liveFor(w.id);
    const c = connectionsOnPort(w.port, socks);
    if (c) {
      l.connections = c.total;
      l.uniqueIps = c.uniqueIps;
      l.topIps = [...c.perIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ip, count]) => ({ ip, count }));
    }
  }

  const st = await hostAgentStatus();
  if (!st.ok || list.length === 0) return;
  let out: string;
  try {
    out = await helper(["stats"], undefined, 10000);
  } catch (e) {
    console.error("[monitor] stats failed", (e as Error).message);
    return;
  }
  const now = Date.now();
  const deltas = new Map<number, { rx: number; tx: number }>();
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] === "tc" && f.length === 4) {
      const id = parseInt(f[2], 16) - 16;
      const bytes = Number(f[3]);
      const key = `${f[1]}:${id}`;
      const prev = mon.prevTc.get(key);
      const l = liveFor(id);
      if (prev && now > prev.at) {
        const delta = bytes >= prev.bytes ? bytes - prev.bytes : bytes; // counter reset => count from 0
        const rate = delta / ((now - prev.at) / 1000);
        const d = deltas.get(id) || { rx: 0, tx: 0 };
        if (f[1] === "egress") { l.txRate = rate; d.tx += delta; } else { l.rxRate = rate; d.rx += delta; }
        deltas.set(id, d);
      }
      mon.prevTc.set(key, { bytes, at: now });
    } else if (f[0] === "acct" && f.length === 3) {
      liveFor(Number(f[1])).attempts = Number(f[2]);
    }
  }
  for (const [id, d] of deltas) {
    if (d.rx === 0 && d.tx === 0) continue;
    await db.update(workers).set({
      trafficRxBytes: sql`${workers.trafficRxBytes} + ${d.rx}`,
      trafficTxBytes: sql`${workers.trafficTxBytes} + ${d.tx}`,
    }).where(eq(workers.id, id));
  }
}

/** ~30s: persist measurements for history charts; prune old rows. */
export async function persist(list: { id: number; trafficRxBytes: number; trafficTxBytes: number }[]) {
  const now = Date.now();
  if (now - mon.lastPersist < 30000) return;
  mon.lastPersist = now;
  const recent = mon.history.slice(-30);
  const avg = recent.length ? recent.reduce((a, s) => a + s.cpu, 0) / recent.length : null;
  const mem = readMem();
  await db.insert(resourceMeasurements).values({
    scope: "global",
    cpuPercent: avg,
    memBytes: mem ? mem.used : null,
    extra: { load: readLoad(), netRate: mon.netRate },
  });
  for (const w of list) {
    const l = mon.live.get(w.id);
    if (!l) continue;
    await db.insert(resourceMeasurements).values({ scope: "worker", workerId: w.id, cpuPercent: l.cpuPercent, memBytes: l.memBytes });
    if (l.connections != null) {
      await db.insert(connectionStats).values({ workerId: w.id, activeConnections: l.connections, uniqueIps: l.uniqueIps ?? 0, attempts: l.attempts });
    }
    if (l.rxRate != null || l.txRate != null) {
      await db.insert(bandwidthStats).values({ workerId: w.id, rxBytes: w.trafficRxBytes, txBytes: w.trafficTxBytes, rxRate: l.rxRate ?? 0, txRate: l.txRate ?? 0 });
    }
  }
  if (Math.random() < 0.05) {
    const days = (await getGeneral()).statsRetentionDays;
    const cutoff = new Date(now - days * 86400000);
    await db.delete(resourceMeasurements).where(lt(resourceMeasurements.ts, cutoff));
    await db.delete(connectionStats).where(lt(connectionStats.ts, cutoff));
    await db.delete(bandwidthStats).where(lt(bandwidthStats.ts, cutoff));
  }
}

export function systemSnapshot() {
  const mem = readMem();
  const last = mon.history[mon.history.length - 1] || null;
  return {
    cpu: last?.cpu ?? null,
    cores: last?.cores ?? [],
    cpuHistory: mon.history.slice(-120).map((s) => ({ ts: s.ts, cpu: Math.round(s.cpu * 10) / 10 })),
    mem,
    load: readLoad(),
    disk: readDisk("/"),
    uptime: readUptime(),
    netRate: mon.netRate,
    ncpu: os.cpus().length,
    hostname: os.hostname(),
  };
}
