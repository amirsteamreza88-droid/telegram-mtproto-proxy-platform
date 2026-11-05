"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { api, Badge, Button, Card, copyText, Empty, ErrorBox, Field, fmtBytes, fmtKbps, fmtPct, fmtRate, inputCls, Loading, Modal, StatusBadge, Toggle, usePoll, useUI } from "@/components/ui";
import { MODE_LABEL, SPONSOR_LABEL, type WorkerDTO } from "@/components/types";
import { watchJob } from "@/components/jobs";
import { LogsModal } from "@/components/LogsModal";

export default function WorkersPage() {
  const { data, error, loading, reload } = usePoll<{ workers: WorkerDTO[] }>("/api/workers", 3000);
  const { toast, confirm } = useUI();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [mode, setMode] = useState("all");
  const [creating, setCreating] = useState(false);
  const [logsFor, setLogsFor] = useState<WorkerDTO | null>(null);
  const [busy, setBusy] = useState<Record<number, string>>({});

  const list = useMemo(() => (data?.workers || []).filter((w) =>
    (status === "all" || w.status === status) && (mode === "all" || w.mode === mode) &&
    (!q || `${w.id} ${w.name} ${w.port}`.toLowerCase().includes(q.toLowerCase()))), [data, q, status, mode]);

  const runJob = async (w: WorkerDTO, label: string, p: Promise<{ jobId: string }>) => {
    setBusy((b) => ({ ...b, [w.id]: label }));
    try {
      const { jobId } = await p;
      const job = await watchJob(jobId, (_pct, step) => setBusy((b) => ({ ...b, [w.id]: step || label })));
      if (job.status === "succeeded") toast("success", `#${w.id} ${w.name}: ${label} completed`);
      else toast("error", `#${w.id} ${label} failed: ${job.error}`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[w.id]; return n; });
      reload();
    }
  };
  const action = async (w: WorkerDTO, a: string) => {
    if (a === "stop" && !(await confirm({ title: `Stop worker #${w.id}?`, body: `All clients connected to port ${w.port} will be disconnected.`, danger: true, confirmLabel: "Stop" }))) return;
    runJob(w, a, api("/api/workers/" + w.id + "/action", { method: "POST", json: { action: a } }));
  };
  const del = async (w: WorkerDTO) => {
    if (!(await confirm({ title: `Delete worker #${w.id} "${w.name}"?`, body: "The systemd service, configuration, traffic shaping and firewall rules will be removed. The secret will be destroyed. This cannot be undone.", danger: true, confirmLabel: "Delete" }))) return;
    runJob(w, "delete", api("/api/workers/" + w.id, { method: "DELETE" }));
  };
  const copy = async (w: WorkerDTO, what: "link" | "secret") => {
    try {
      const r = await api<{ secret: string; clientSecret: string; https: string | null }>(`/api/workers/${w.id}/secret`);
      if (what === "link") {
        if (!r.https) throw new Error("Public IP unknown – set it in Settings");
        await copyText(r.https);
      } else await copyText(r.clientSecret);
      toast("success", what === "link" ? "Connection link copied" : "Client secret copied");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Proxy Workers</h1>
        <Button onClick={() => setCreating(true)}>+ Create worker</Button>
      </div>
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className={`${inputCls} max-w-xs`} placeholder="Search id, name, port…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={`${inputCls} max-w-[160px]`} value={status} onChange={(e) => setStatus(e.target.value)}>
            {["all", "active", "deploying", "pending", "stopped", "failed", "error"].map((s) => <option key={s} value={s}>{s === "all" ? "All statuses" : s}</option>)}
          </select>
          <select className={`${inputCls} max-w-[180px]`} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="all">All modes</option>
            {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <ErrorBox error={error} />
        {loading && !data ? <Loading /> : list.length === 0 ? (
          <Empty title={data?.workers.length ? "No workers match your filters" : "No workers yet"}>
            {!data?.workers.length && "Create your first MTProto proxy worker. Each worker is an isolated systemd service with its own port, secret and limits."}
          </Empty>
        ) : (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[1600px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
                <tr>{["ID", "Name", "Port", "Secret", "Mode", "Status", "Net rules", "Conns", "Conn limit", "↓ limit", "↑ limit", "Bandwidth now", "CPU", "RAM", "Traffic", "Sponsor", "EPOLL", ""].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.map((w) => {
                  const sp = SPONSOR_LABEL[w.sponsorState] || SPONSOR_LABEL.none;
                  const b = busy[w.id];
                  return (
                    <tr key={w.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-3 py-2 text-slate-500">#{w.id}</td>
                      <td className="px-3 py-2 font-medium"><Link href={`/workers/${w.id}`} className="text-sky-700 hover:underline dark:text-sky-400">{w.name}</Link></td>
                      <td className="mono px-3 py-2">{w.port}</td>
                      <td className="mono px-3 py-2 text-xs text-slate-500">{w.secretMasked}</td>
                      <td className="px-3 py-2"><Badge color="blue">{MODE_LABEL[w.mode] || w.mode}</Badge></td>
                      <td className="px-3 py-2" title={w.statusMessage || ""}>
                        <div className="flex flex-col gap-0.5"><StatusBadge status={w.status} />{w.restrictions.length > 0 && <Badge color="amber">protected ×{w.restrictions.length}</Badge>}</div>
                      </td>
                      <td className="px-3 py-2" title={w.netStatus ? Object.entries(w.netStatus.components).map(([k, v]) => `${k}=${v}`).join(" ") + (w.netStatus.error ? `\n${w.netStatus.error}` : "") : "not applied yet"}>
                        {!w.netStatus ? <Badge>not applied</Badge>
                          : w.netStatus.enforced ? <Badge color="green">enforced</Badge>
                          : w.netStatus.partial ? <Badge color="amber">partial</Badge>
                          : <Badge color="red">failed</Badge>}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{w.live?.connections ?? "—"}<div className="text-[10px] text-slate-400">{w.live?.uniqueIps != null ? `${w.live.uniqueIps} IPs` : ""}</div></td>
                      <td className="px-3 py-2">{w.connLimitEnabled ? <>{w.maxConnections}{w.netStatus && w.netStatus.components.nft_global && w.netStatus.components.nft_global !== "ok" && w.netStatus.components.nft_global !== "off" ? <span className="text-rose-600"> (not enforced)</span> : null}</> : "Off"}</td>
                      <td className="px-3 py-2 text-xs">{w.bwLimitEnabled ? fmtKbps(w.downloadKbps) : "Unlimited"}</td>
                      <td className="px-3 py-2 text-xs">{w.bwLimitEnabled ? fmtKbps(w.uploadKbps) : "Unlimited"}</td>
                      <td className="px-3 py-2 text-xs">↓ {fmtRate(w.live?.txRate)}<br />↑ {fmtRate(w.live?.rxRate)}</td>
                      <td className="px-3 py-2 tabular-nums">{fmtPct(w.live?.cpuPercent)}</td>
                      <td className="px-3 py-2 tabular-nums">{fmtBytes(w.live?.memBytes)}</td>
                      <td className="px-3 py-2 tabular-nums">{fmtBytes(w.trafficRxBytes + w.trafficTxBytes)}</td>
                      <td className="px-3 py-2"><Badge color={sp.color}>{sp.label}</Badge></td>
                      <td className="px-3 py-2 text-xs" title={w.epollStatus}>{w.epollStatus.startsWith("active") ? <Badge color="green">active</Badge> : <Badge>{w.epollStatus.slice(0, 16)}</Badge>}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {b ? <span className="text-xs text-sky-600">{b}…</span> : (
                          <div className="flex flex-wrap gap-1">
                            {w.desiredState === "stopped" || ["failed", "stopped"].includes(w.status)
                              ? <Button size="sm" variant="secondary" onClick={() => action(w, w.status === "failed" && w.desiredState === "running" ? "redeploy" : "start")}>Start</Button>
                              : <Button size="sm" variant="secondary" onClick={() => action(w, "stop")}>Stop</Button>}
                            <Button size="sm" variant="secondary" onClick={() => action(w, "restart")}>Restart</Button>
                            <Button size="sm" variant="ghost" onClick={() => copy(w, "link")}>Link</Button>
                            <Button size="sm" variant="ghost" onClick={() => copy(w, "secret")}>Secret</Button>
                            <Button size="sm" variant="ghost" onClick={() => setLogsFor(w)}>Logs</Button>
                            <Link href={`/workers/${w.id}`}><Button size="sm" variant="ghost">Edit / Sponsor</Button></Link>
                            <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => del(w)}>Delete</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <CreateWorker open={creating} onClose={() => setCreating(false)} onCreated={(w, jobId) => { setCreating(false); reload(); runJob(w, "deploy", Promise.resolve({ jobId })); }} />
      <LogsModal worker={logsFor} onClose={() => setLogsFor(null)} />
    </div>
  );
}

function CreateWorker({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (w: WorkerDTO, jobId: string) => void }) {
  const { toast } = useUI();
  const [f, setF] = useState({ name: "", port: "443", mode: "faketls", tlsDomain: "www.cloudflare.com", customSecret: "", maxConnections: "", connLimitEnabled: false, downloadKbps: "", uploadKbps: "", bwLimitEnabled: false, sponsorMode: "none" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tls, setTls] = useState<{ ok: boolean; detail: string } | null>(null);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const checkTls = async () => {
    setTls(null);
    try { setTls(await api("/api/tls-check", { method: "POST", json: { domain: f.tlsDomain } })); } catch (e) { setTls({ ok: false, detail: (e as Error).message }); }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ worker: WorkerDTO; jobId: string }>("/api/workers", { method: "POST", json: { ...f, customSecret: f.customSecret || undefined } });
      toast("info", `Worker #${r.worker.id} created – deploying…`);
      onCreated(r.worker, r.jobId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Create proxy worker" wide>
      <form onSubmit={submit} className="space-y-4">
        <ErrorBox error={err} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Worker name"><input className={inputCls} value={f.name} onChange={(e) => set("name", e.target.value)} required placeholder="e.g. main-443" /></Field>
          <Field label="Listening port" hint="Checked against other workers, reserved ports and live listeners"><input className={inputCls} type="number" min={1} max={65535} value={f.port} onChange={(e) => set("port", e.target.value)} required /></Field>
          <Field label="Proxy mode">
            <select className={inputCls} value={f.mode} onChange={(e) => set("mode", e.target.value)}>
              <option value="classic">Standard MTProto</option>
              <option value="secure">Random padding (dd prefix in the client link; server config identical to classic)</option>
              <option value="faketls">Fake-TLS (ee, server -D domain)</option>
            </select>
          </Field>
          {f.mode === "faketls" ? (
            <Field label="Fake-TLS hostname" hint={tls ? <span className={tls.ok ? "text-emerald-600" : "text-rose-600"}>{tls.detail}</span> : "Must resolve and serve TLS 1.3 on port 443"}>
              <div className="flex gap-2"><input className={inputCls} value={f.tlsDomain} onChange={(e) => { set("tlsDomain", e.target.value); setTls(null); }} required /><Button type="button" variant="secondary" onClick={checkTls}>Check</Button></div>
            </Field>
          ) : <div />}
          <Field label="Secret" hint="Leave empty to generate a cryptographically secure random 16-byte secret (recommended)"><input className={`${inputCls} mono`} value={f.customSecret} onChange={(e) => set("customSecret", e.target.value)} placeholder="auto-generate" /></Field>
          <Field label="Sponsorship">
            <select className={inputCls} value={f.sponsorMode} onChange={(e) => set("sponsorMode", e.target.value)}>
              <option value="none">No sponsor</option>
              <option value="waiting">Register with @MTProxybot (waiting for tag)</option>
            </select>
          </Field>
        </div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <Toggle checked={f.connLimitEnabled} onChange={(v) => set("connLimitEnabled", v)} label="Limit concurrent connections (enforced with iptables connlimit)" />
          {f.connLimitEnabled && <div className="mt-2 max-w-xs"><Field label="Max concurrent TCP connections"><input className={inputCls} type="number" min={1} value={f.maxConnections} onChange={(e) => set("maxConnections", e.target.value)} required /></Field></div>}
        </div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <Toggle checked={f.bwLimitEnabled} onChange={(v) => set("bwLimitEnabled", v)} label="Limit bandwidth (Linux tc HTB, per worker port)" />
          {f.bwLimitEnabled && (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label="Client download limit (kbit/s)"><input className={inputCls} type="number" min={64} value={f.downloadKbps} onChange={(e) => set("downloadKbps", e.target.value)} placeholder="e.g. 20000" /></Field>
              <Field label="Client upload limit (kbit/s)"><input className={inputCls} type="number" min={64} value={f.uploadKbps} onChange={(e) => set("uploadKbps", e.target.value)} placeholder="e.g. 10000" /></Field>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={busy}>{busy ? "Creating…" : "Create & deploy"}</Button>
        </div>
      </form>
    </Modal>
  );
}
