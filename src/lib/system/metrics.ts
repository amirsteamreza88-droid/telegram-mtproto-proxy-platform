import fs from "node:fs";
import os from "node:os";

// Real measurements only: /proc and cgroup v2. If a source is unreadable the
// value is reported as null ("not measurable") rather than estimated.

function readFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export interface CpuTimes { total: number; idle: number }

export function readCpuTimes(): { all: CpuTimes; cores: CpuTimes[] } | null {
  const txt = readFile("/proc/stat");
  if (!txt) return null;
  const cores: CpuTimes[] = [];
  let all: CpuTimes | null = null;
  for (const line of txt.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const parts = line.trim().split(/\s+/);
    const nums = parts.slice(1).map(Number);
    // user nice system idle iowait irq softirq steal (guest already included in user)
    const idle = (nums[3] || 0) + (nums[4] || 0);
    const total = nums.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    if (parts[0] === "cpu") all = { total, idle };
    else cores.push({ total, idle });
  }
  return all ? { all, cores } : null;
}

export function cpuPercent(prev: CpuTimes, cur: CpuTimes): number {
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, ((dt - di) / dt) * 100));
}

export function readMem(): { total: number; available: number; used: number } | null {
  const txt = readFile("/proc/meminfo");
  if (!txt) return null;
  const kv: Record<string, number> = {};
  for (const l of txt.split("\n")) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal || 0;
  const available = kv.MemAvailable ?? kv.MemFree ?? 0;
  return { total, available, used: total - available };
}

export function readLoad(): [number, number, number] | null {
  const t = readFile("/proc/loadavg");
  if (!t) return null;
  const p = t.split(" ").map(Number);
  return [p[0], p[1], p[2]];
}

export function readUptime(): number {
  const t = readFile("/proc/uptime");
  return t ? Number(t.split(" ")[0]) : os.uptime();
}

export function readDisk(path = "/"): { total: number; free: number; used: number } | null {
  try {
    const s = fs.statfsSync(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

export function readNet(): { rx: number; tx: number; ifaces: Record<string, { rx: number; tx: number }> } | null {
  const t = readFile("/proc/net/dev");
  if (!t) return null;
  let rx = 0, tx = 0;
  const ifaces: Record<string, { rx: number; tx: number }> = {};
  for (const line of t.split("\n").slice(2)) {
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    const f = m[2].split(/\s+/).map(Number);
    if (name === "lo" || name.startsWith("ifb")) continue;
    ifaces[name] = { rx: f[0], tx: f[8] };
    rx += f[0];
    tx += f[8];
  }
  return { rx, tx, ifaces };
}

const CGROUP_ROOT = process.env.CGROUP_ROOT || "/sys/fs/cgroup";

export function workerCgroupPath(id: number): string {
  return `${CGROUP_ROOT}/system.slice/system-mtproxy.slice/mtproxy@${id}.service`;
}

/** cgroup v2 accounting for the worker's systemd unit. null => not measurable. */
export function readWorkerCgroup(id: number): { cpuUsec: number; memBytes: number } | null {
  const base = workerCgroupPath(id);
  const cpu = readFile(`${base}/cpu.stat`);
  const mem = readFile(`${base}/memory.current`);
  if (!cpu || !mem) return null;
  const m = cpu.match(/usage_usec\s+(\d+)/);
  if (!m) return null;
  return { cpuUsec: Number(m[1]), memBytes: Number(mem.trim()) };
}

export function epollSupported(): boolean {
  return fs.existsSync("/proc/sys/fs/epoll/max_user_watches");
}

// ---- TCP socket table parsing (/proc/net/tcp, tcp6) ----

function hexToIPv4(h: string): string {
  return [h.slice(6, 8), h.slice(4, 6), h.slice(2, 4), h.slice(0, 2)].map((x) => parseInt(x, 16)).join(".");
}

function hexToIPv6(h: string): string {
  // 4 little-endian 32-bit words
  const words: string[] = [];
  for (let i = 0; i < 4; i++) {
    const w = h.slice(i * 8, i * 8 + 8);
    words.push(w.slice(6, 8) + w.slice(4, 6) + w.slice(2, 4) + w.slice(0, 2));
  }
  const full = words.join("");
  if (full.startsWith("00000000000000000000ffff")) return hexToIPv4(words[3].match(/../g)!.reverse().join(""));
  return full.match(/.{4}/g)!.map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

export interface SockEntry { localPort: number; remoteIp: string; state: string }

export function readTcpSockets(): SockEntry[] | null {
  const out: SockEntry[] = [];
  let any = false;
  for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]] as const) {
    const t = readFile(file);
    if (!t) continue;
    any = true;
    for (const line of t.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4) continue;
      const [, lport] = f[1].split(":");
      const [rip] = f[2].split(":");
      out.push({ localPort: parseInt(lport, 16), remoteIp: v6 ? hexToIPv6(rip) : hexToIPv4(rip), state: f[3] });
    }
  }
  return any ? out : null;
}

export function listeningPorts(socks = readTcpSockets()): Set<number> {
  return new Set((socks || []).filter((s) => s.state === "0A").map((s) => s.localPort));
}

/** Established inbound TCP connections on a port, and per-IP counts. */
export function connectionsOnPort(port: number, socks = readTcpSockets()) {
  if (!socks) return null;
  const perIp = new Map<string, number>();
  let total = 0;
  for (const s of socks) {
    if (s.state === "01" && s.localPort === port) {
      total++;
      perIp.set(s.remoteIp, (perIp.get(s.remoteIp) || 0) + 1);
    }
  }
  return { total, uniqueIps: perIp.size, perIp };
}
