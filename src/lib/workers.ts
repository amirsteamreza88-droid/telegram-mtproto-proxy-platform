import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { and, desc, eq, max, ne } from "drizzle-orm";
import { db } from "@/db";
import { proxySecrets, restrictions, sponsorships, workerConfigs, workers, type Worker } from "@/db/schema";
import { decrypt, encrypt } from "./crypto";
import { clientSecret, isValidDomain, isValidSecret, isValidSponsorTag, parseMtproxyStats, proxyLinks, type ProxyMode } from "./core/mtproto";
import { HELPER, helper, hostAgentStatus, run, SUDO, unitStatus } from "./system/host";
import { parseNetStatus, type NetStatus } from "./core/netstatus";
import { epollSupported, listeningPorts, readDisk, readMem } from "./system/metrics";
import { getGeneral, getMeta, setMeta, logActivity } from "./settings";

export type Progress = (pct: number, step: string) => Promise<void>;

export async function getSecret(workerId: number): Promise<string> {
  const r = await db.select().from(proxySecrets)
    .where(and(eq(proxySecrets.workerId, workerId), eq(proxySecrets.active, true)))
    .orderBy(desc(proxySecrets.id)).limit(1);
  if (!r[0]) throw new Error(`Worker ${workerId} has no secret`);
  return decrypt(r[0].secretEnc);
}

export async function getSponsorship(workerId: number) {
  const r = await db.select().from(sponsorships).where(eq(sponsorships.workerId, workerId)).limit(1);
  const s = r[0];
  return {
    state: s?.state ?? "none",
    tag: s?.tagEnc ? decrypt(s.tagEnc) : null,
    requestedAt: s?.requestedAt ?? null,
    activatedAt: s?.activatedAt ?? null,
    verifiedAt: s?.verifiedAt ?? null,
  };
}

// ---------- public address ----------
export async function resolvePublicHost(force = false): Promise<string | null> {
  const gen = await getGeneral();
  if (gen.publicHost) return gen.publicHost;
  const cached = await getMeta<{ ip: string | null; at: number }>("publicIp", { ip: null, at: 0 });
  if (!force && cached.ip && Date.now() - cached.at < 6 * 3600_000) return cached.ip;
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip", "https://ipv4.icanhazip.com"]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const ip = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        await setMeta("publicIp", { ip, at: Date.now() });
        return ip;
      }
    } catch { /* try next */ }
  }
  return cached.ip;
}

export async function workerLinks(w: Worker) {
  const host = w.publicIp || (await resolvePublicHost());
  const secret = await getSecret(w.id);
  const cs = clientSecret(w.mode as ProxyMode, secret, w.tlsDomain);
  return { host, clientSecret: cs, ...(host ? proxyLinks(host, w.port, cs) : { tg: null, https: null }) };
}

// ---------- validation ----------
export async function checkPort(port: number, excludeWorkerId?: number): Promise<string | null> {
  const gen = await getGeneral();
  if (gen.reservedPorts.includes(port)) return `Port ${port} is reserved (panel/system)`;
  const others = await db.select({ id: workers.id, port: workers.port, statsPort: workers.statsPort }).from(workers);
  for (const o of others) {
    if (o.id === excludeWorkerId) continue;
    if (o.port === port || o.statsPort === port) return `Port ${port} is already used by worker #${o.id}`;
  }
  const listening = listeningPorts();
  if (listening.has(port)) {
    if (excludeWorkerId) {
      const st = await unitStatus(excludeWorkerId);
      if (st.activeState === "active") return null; // it's our own running service
    }
    return `Port ${port} is already in use by another process on this host`;
  }
  return null;
}

export async function allocateStatsPort(): Promise<number> {
  const r = await db.select({ m: max(workers.statsPort) }).from(workers);
  const listening = listeningPorts();
  let p = Math.max(18000, r[0]?.m ?? 18000) + 1;
  while (listening.has(p)) p++;
  return p;
}

/** Validate Fake-TLS domain: DNS resolves and the host serves TLS 1.3 on 443. */
export async function validateTlsDomain(domain: string): Promise<{ ok: boolean; detail: string }> {
  if (!isValidDomain(domain)) return { ok: false, detail: "Invalid hostname" };
  try {
    const addrs = await dns.resolve4(domain);
    if (!addrs.length) return { ok: false, detail: "Domain has no A records" };
  } catch (e) {
    return { ok: false, detail: `DNS resolution failed: ${(e as Error).message}` };
  }
  return new Promise((resolve) => {
    const s = tls.connect({ host: domain, port: 443, servername: domain, minVersion: "TLSv1.3", timeout: 6000 }, () => {
      const proto = s.getProtocol();
      s.end();
      resolve(proto === "TLSv1.3" ? { ok: true, detail: `TLS 1.3 OK (${domain})` } : { ok: false, detail: `Negotiated ${proto}, TLS 1.3 required` });
    });
    s.on("error", (e) => resolve({ ok: false, detail: `TLS check failed: ${e.message}` }));
    s.on("timeout", () => { s.destroy(); resolve({ ok: false, detail: "TLS check timed out" }); });
  });
}

export function resourceCheck(): string | null {
  const mem = readMem();
  if (mem && mem.available < 48 * 1024 * 1024) return `Insufficient free memory (${Math.round(mem.available / 1048576)} MiB available)`;
  const disk = readDisk("/");
  if (disk && disk.free < 200 * 1024 * 1024) return "Insufficient free disk space (<200 MiB)";
  return null;
}

// ---------- host configuration ----------
export function workerConfigObject(w: Worker, tag: string | null) {
  return {
    port: w.port,
    statsPort: w.statsPort,
    mode: w.mode,
    tlsDomain: w.mode === "faketls" ? w.tlsDomain : null,
    sponsorTagSet: !!tag,
  };
}

export async function writeHostConfig(w: Worker): Promise<void> {
  const secret = await getSecret(w.id);
  const sp = await getSponsorship(w.id);
  const tag = sp.state === "active" ? sp.tag : null;
  if (!isValidSecret(secret)) throw new Error("Stored secret is invalid");
  if (tag && !isValidSponsorTag(tag)) throw new Error("Stored sponsor tag is invalid");
  if (w.mode === "faketls" && (!w.tlsDomain || !isValidDomain(w.tlsDomain))) throw new Error("Fake-TLS requires a valid domain");
  const lines = [
    `PORT=${w.port}`,
    `STATS_PORT=${w.statsPort}`,
    `SECRET=${secret}`,
    `MODE=${w.mode}`,
    `DOMAIN=${w.mode === "faketls" ? w.tlsDomain : ""}`,
    `TAG=${tag ?? ""}`,
    `MAXCONN=${w.connLimitEnabled && w.maxConnections ? w.maxConnections : 0}`,
  ];
  await helper(["write-config", w.id], lines.join("\n") + "\n");
}

/** Effective limits = configured limits further reduced by active protection restrictions. */
export async function effectiveNetLimits(w: Worker) {
  const active = await db.select().from(restrictions).where(and(eq(restrictions.workerId, w.id), eq(restrictions.active, true)));
  let down = w.bwLimitEnabled ? w.downloadKbps || 0 : 0;
  let up = w.bwLimitEnabled ? w.uploadKbps || 0 : 0;
  let perIp = 0;
  const blocks: string[] = [];
  for (const r of active) {
    const v = r.value as Record<string, number>;
    if (r.kind === "bandwidth") {
      if (v.downKbps) down = down ? Math.min(down, v.downKbps) : v.downKbps;
      if (v.upKbps) up = up ? Math.min(up, v.upKbps) : v.upKbps;
    } else if (r.kind === "conn_per_ip" && v.limit) {
      perIp = perIp ? Math.min(perIp, v.limit) : v.limit;
    } else if (r.kind === "ip_block" && r.target) {
      blocks.push(r.target);
    }
  }
  const total = w.connLimitEnabled ? w.maxConnections || 0 : 0;
  return { down, up, total, perIp, blocks };
}

export async function applyNetRules(w: Worker): Promise<NetStatus> {
  const l = await effectiveNetLimits(w);
  const input = [
    `PORT=${w.port}`, `DOWN=${l.down}`, `UP=${l.up}`, `TOTAL=${l.total}`, `PERIP=${l.perIp}`,
    `BLOCKS=${l.blocks.join(",")}`,
  ].join("\n") + "\n";
  const st = await hostAgentStatus();
  if (!st.ok) {
    const ns: NetStatus = { at: new Date().toISOString(), exitCode: null, error: st.reason, components: {}, enforced: false, partial: false };
    await db.update(workers).set({ netStatus: JSON.stringify(ns), updatedAt: new Date() }).where(eq(workers.id, w.id));
    throw new Error(`Host agent unavailable, network rules NOT applied: ${st.reason}`);
  }
  // Run raw (not helper()) because the helper intentionally exits 1/3 on partial
  // failure; the NETSTATUS line on stdout carries the accurate per-component state.
  const r = await run(SUDO, ["-n", HELPER, "net-apply", String(w.id)], { input, timeoutMs: 60000 });
  const ns = parseNetStatus(r.stdout, r.code, r.stderr);
  await db.update(workers).set({ netStatus: JSON.stringify(ns), updatedAt: new Date() }).where(eq(workers.id, w.id));
  if (r.code !== 0) {
    const bad = Object.entries(ns.components).filter(([k, v]) => !["id", "port"].includes(k) && v !== "ok" && v !== "off").map(([k, v]) => `${k}=${v}`).join(" ");
    throw new Error(`Network rules not fully applied (exit ${r.code}): ${bad || r.stderr.slice(0, 300)}. Working components were kept.`);
  }
  return ns;
}

async function waitActive(id: number, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  let st = await unitStatus(id);
  while (Date.now() < until) {
    st = await unitStatus(id);
    if (st.activeState === "active" && st.mainPid > 0) return st;
    if (st.activeState === "failed") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return st;
}

export function tcpProbe(port: number, host = "127.0.0.1", timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function fetchMtproxyStats(statsPort: number): Promise<Record<string, string> | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${statsPort}/stats`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return parseMtproxyStats(await r.text());
  } catch {
    return null;
  }
}

/** Verify process, listening port, stats endpoint and EPOLL usage. Throws on failure. */
export async function verifyWorker(w: Worker, progress?: Progress): Promise<{ epoll: string }> {
  await progress?.(70, "Verifying process health");
  // give the proxy time to load the config & start listening
  let st = await waitActive(w.id, 15000);
  if (st.activeState !== "active") {
    const logs = await helper(["logs", w.id, 30]).catch(() => "");
    throw new Error(`Service not active (state=${st.activeState}/${st.subState}). Last logs:\n${logs.slice(-1500)}`);
  }
  await progress?.(78, "Verifying listening port");
  let listening = false;
  for (let i = 0; i < 20 && !listening; i++) {
    listening = await tcpProbe(w.port);
    if (!listening) await new Promise((r) => setTimeout(r, 500));
  }
  if (!listening) throw new Error(`Port ${w.port} is not accepting connections`);
  st = await unitStatus(w.id);
  if (st.activeState !== "active") throw new Error("Service exited right after start (crash loop?)");

  await progress?.(84, "Checking EPOLL");
  let epoll = "unsupported";
  if (epollSupported()) {
    try {
      const out = (await helper(["epoll", w.id])).trim();
      const n = Number(out);
      epoll = n > 0 ? `active (${n} eventpoll fd)` : "not detected";
    } catch (e) {
      epoll = `check failed: ${(e as Error).message.slice(0, 120)}`;
    }
  }
  return { epoll };
}

async function saveConfigVersion(w: Worker, ok: boolean | null) {
  const sp = await getSponsorship(w.id);
  await db.insert(workerConfigs).values({ workerId: w.id, version: w.configVersion, config: workerConfigObject(w, sp.state === "active" ? sp.tag : null), appliedOk: ok });
}

export async function loadWorker(id: number): Promise<Worker> {
  const r = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
  if (!r[0]) throw new Error(`Worker ${id} not found`);
  return r[0];
}

async function setStatus(id: number, status: string, statusMessage: string | null, extra: Partial<Worker> = {}) {
  await db.update(workers).set({ status, statusMessage, updatedAt: new Date(), ...extra }).where(eq(workers.id, id));
}

// ---------- lifecycle ----------
export async function deployWorker(id: number, progress: Progress) {
  let w = await loadWorker(id);
  await setStatus(id, "deploying", "Deployment in progress");
  try {
    await progress(5, "Validating settings");
    if (w.mode === "faketls") {
      const v = await validateTlsDomain(w.tlsDomain || "");
      if (!v.ok) throw new Error(`Fake-TLS domain validation failed: ${v.detail}`);
    }
    await progress(12, "Checking available resources");
    const rc = resourceCheck();
    if (rc) throw new Error(rc);
    await progress(20, "Checking port availability");
    const pc = await checkPort(w.port, id);
    if (pc) throw new Error(pc);
    if (listeningPorts().has(w.statsPort)) {
      const st = await unitStatus(id);
      if (st.activeState !== "active") throw new Error(`Stats port ${w.statsPort} is in use`);
    }
    await progress(30, "Verifying secret");
    await getSecret(id);
    await progress(40, "Generating configuration");
    await writeHostConfig(w);
    await progress(50, "Creating isolated service");
    await helper(["enable", id]);
    await progress(58, "Applying network rules");
    await applyNetRules(w);
    await progress(62, "Starting service");
    await helper(["restart", id]);
    const { epoll } = await verifyWorker(w, progress);
    await progress(90, "Retrieving public IP");
    const ip = await resolvePublicHost(true);
    await progress(95, "Saving metadata");
    await setStatus(id, "active", "Verified: process running and port accepting connections", {
      epollStatus: epoll, publicIp: ip, lastVerifiedAt: new Date(), desiredState: "running",
    });
    w = await loadWorker(id);
    await saveConfigVersion(w, true);
    await logActivity("system", "worker.deployed", `worker:${id}`, { port: w.port, mode: w.mode, epoll });
    await progress(100, "Deployed");
    return { links: await workerLinks(w) };
  } catch (e) {
    const msg = (e as Error).message;
    await helper(["stop", id]).catch(() => {});
    await setStatus(id, "failed", `Deployment failed: ${msg}`.slice(0, 2000));
    await logActivity("system", "worker.deploy_failed", `worker:${id}`, { error: msg }, "error");
    throw e;
  }
}

export async function startWorker(id: number, progress: Progress) {
  const w = await loadWorker(id);
  await progress(20, "Writing configuration");
  await writeHostConfig(w);
  await helper(["enable", id]);
  await applyNetRules(w);
  await progress(40, "Starting service");
  await helper(["start", id]);
  try {
    const { epoll } = await verifyWorker(w, progress);
    await setStatus(id, "active", "Running (verified)", { epollStatus: epoll, lastVerifiedAt: new Date(), desiredState: "running" });
  } catch (e) {
    await setStatus(id, "failed", `Start failed: ${(e as Error).message}`.slice(0, 2000), { desiredState: "running" });
    throw e;
  }
  await progress(100, "Started");
}

export async function stopWorker(id: number, progress: Progress) {
  await db.update(workers).set({ desiredState: "stopped" }).where(eq(workers.id, id));
  await progress(30, "Stopping service");
  await helper(["stop", id]);
  await helper(["disable", id]);
  const st = await unitStatus(id);
  if (st.activeState === "active") throw new Error("Service still active after stop");
  await setStatus(id, "stopped", "Stopped by administrator");
  await progress(100, "Stopped");
}

export async function restartWorker(id: number, progress: Progress) {
  const w = await loadWorker(id);
  await progress(20, "Writing configuration");
  await writeHostConfig(w);
  await applyNetRules(w);
  await progress(40, "Restarting service");
  await helper(["restart", id]);
  try {
    const { epoll } = await verifyWorker(w, progress);
    await setStatus(id, "active", "Restarted (verified)", { epollStatus: epoll, lastVerifiedAt: new Date(), desiredState: "running", restartCount: w.restartCount + 1 });
  } catch (e) {
    await setStatus(id, "failed", `Restart failed: ${(e as Error).message}`.slice(0, 2000));
    throw e;
  }
  await progress(100, "Restarted");
}

/**
 * Apply an updated configuration (port/mode/domain/secret/sponsor tag).
 * The previous config is kept; on failed verification we roll back and restart.
 */
export async function applyWorkerUpdate(id: number, payload: { previous: Partial<Worker>; previousSecretId?: number; previousSponsor?: { state: string; tagEnc: string | null } }, progress: Progress) {
  const w = await loadWorker(id);
  await saveConfigVersion(w, null);
  if (w.desiredState === "stopped") {
    await progress(100, "Saved (worker is stopped; applied on next start)");
    return;
  }
  try {
    await restartWorker(id, progress);
    await db.update(workerConfigs).set({ appliedOk: true }).where(and(eq(workerConfigs.workerId, id), eq(workerConfigs.version, w.configVersion)));
    // tag present in the verified running configuration
    await db.update(sponsorships).set({ verifiedAt: new Date() }).where(and(eq(sponsorships.workerId, id), eq(sponsorships.state, "active")));
  } catch (e) {
    await progress(80, "Verification failed – rolling back to previous configuration");
    await db.update(workers).set({ ...payload.previous, configVersion: w.configVersion + 1 }).where(eq(workers.id, id));
    if (payload.previousSecretId) {
      await db.update(proxySecrets).set({ active: false }).where(and(eq(proxySecrets.workerId, id), ne(proxySecrets.id, payload.previousSecretId)));
      await db.update(proxySecrets).set({ active: true }).where(eq(proxySecrets.id, payload.previousSecretId));
    }
    if (payload.previousSponsor) {
      await db.update(sponsorships).set({ state: payload.previousSponsor.state, tagEnc: payload.previousSponsor.tagEnc }).where(eq(sponsorships.workerId, id));
    }
    await db.update(workerConfigs).set({ appliedOk: false }).where(and(eq(workerConfigs.workerId, id), eq(workerConfigs.version, w.configVersion)));
    try {
      await restartWorker(id, async () => {});
      await logActivity("system", "worker.update_rolled_back", `worker:${id}`, { error: (e as Error).message }, "warn");
    } catch (e2) {
      await logActivity("system", "worker.rollback_failed", `worker:${id}`, { error: (e2 as Error).message }, "error");
    }
    throw new Error(`Update failed and was rolled back: ${(e as Error).message}`);
  }
}

export async function deleteWorker(id: number, progress: Progress) {
  await setStatus(id, "deleting", "Removing service");
  await progress(30, "Removing service and network rules");
  await helper(["remove", id]);
  await progress(80, "Removing database records");
  await db.delete(workers).where(eq(workers.id, id));
  await logActivity("system", "worker.deleted", `worker:${id}`);
  await progress(100, "Deleted");
}

export async function createSecretRecord(workerId: number, secret: string) {
  await db.update(proxySecrets).set({ active: false }).where(eq(proxySecrets.workerId, workerId));
  const r = await db.insert(proxySecrets).values({ workerId, secretEnc: encrypt(secret), active: true }).returning({ id: proxySecrets.id });
  return r[0].id;
}
