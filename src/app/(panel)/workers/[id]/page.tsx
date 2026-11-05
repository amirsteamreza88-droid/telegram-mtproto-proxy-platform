"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, Badge, Button, Card, copyText, ErrorBox, Field, fmtBytes, fmtDate, fmtKbps, fmtPct, fmtRate, inputCls, Loading, Sparkline, Stat, StatusBadge, timeAgo, Toggle, usePoll, useUI } from "@/components/ui";
import { MODE_LABEL, SPONSOR_LABEL, type WorkerDTO } from "@/components/types";
import { watchJob } from "@/components/jobs";
import { LogsModal } from "@/components/LogsModal";

type Detail = { worker: WorkerDTO; links: { host: string | null; tg: string | null; https: string | null } | null; configs: { id: number; version: number; config: Record<string, unknown>; appliedOk: boolean | null; createdAt: string }[] };
type Sponsor = { state: string; requestedAt: string | null; activatedAt: string | null; verifiedAt: string | null; tagSet: boolean; registration: { host: string | null; port: number; hostPort: string | null; secret: string; bot: string } };
type History = { resources: { ts: string; cpuPercent: number | null; memBytes: number | null }[]; connections: { ts: string; activeConnections: number; uniqueIps: number }[]; bandwidth: { ts: string; rxRate: number; txRate: number }[] };

export default function WorkerDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast, confirm } = useUI();
  const { data, error, loading, reload } = usePoll<Detail>(`/api/workers/${id}`, 3000);
  const hist = usePoll<History>(`/api/workers/${id}/history`, 30000);
  const [busy, setBusy] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [secret, setSecret] = useState<{ secret: string; clientSecret: string } | null>(null);

  const track = async (label: string, p: Promise<{ jobId: string | null }>) => {
    setBusy(label);
    try {
      const { jobId } = await p;
      if (jobId) {
        const job = await watchJob(jobId, (_x, step) => setBusy(step || label));
        if (job.status === "succeeded") toast("success", `${label}: done`);
        else toast("error", `${label} failed: ${job.error}`);
      } else toast("success", `${label}: saved`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const w = data.worker;
  const sp = SPONSOR_LABEL[w.sponsorState] || SPONSOR_LABEL.none;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/workers" className="text-xs text-sky-600">← All workers</Link>
          <h1 className="flex items-center gap-2 text-xl font-semibold">#{w.id} {w.name} <StatusBadge status={w.status} /> <Badge color="blue">{MODE_LABEL[w.mode]}</Badge> <Badge color={sp.color}>{sp.label}</Badge></h1>
          <div className="mt-1 text-xs text-slate-500">{w.statusMessage} · last verified {timeAgo(w.lastVerifiedAt)} · config v{w.configVersion}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {busy ? <span className="text-sm text-sky-600">{busy}…</span> : (
            <>
              {w.desiredState === "stopped" ? <Button variant="secondary" onClick={() => track("Start", api(`/api/workers/${w.id}/action`, { method: "POST", json: { action: "start" } }))}>Start</Button>
                : <Button variant="secondary" onClick={async () => (await confirm({ title: "Stop worker?", body: "Connected clients will be disconnected.", danger: true })) && track("Stop", api(`/api/workers/${w.id}/action`, { method: "POST", json: { action: "stop" } }))}>Stop</Button>}
              <Button variant="secondary" onClick={() => track("Restart", api(`/api/workers/${w.id}/action`, { method: "POST", json: { action: "restart" } }))}>Restart</Button>
              {w.status === "failed" && <Button variant="secondary" onClick={() => track("Redeploy", api(`/api/workers/${w.id}/action`, { method: "POST", json: { action: "redeploy" } }))}>Redeploy</Button>}
              <Button variant="secondary" onClick={() => setShowLogs(true)}>View logs</Button>
              <Button variant="danger" onClick={async () => {
                if (!(await confirm({ title: `Delete worker #${w.id}?`, body: "Service, config and network rules will be removed permanently.", danger: true, confirmLabel: "Delete" }))) return;
                await track("Delete", api(`/api/workers/${w.id}`, { method: "DELETE" }));
                router.push("/workers");
              }}>Delete</Button>
            </>
          )}
        </div>
      </div>
      {(w.status === "failed" || w.status === "error") && <ErrorBox error={w.statusMessage} />}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Active connections" value={w.live?.connections ?? "—"} sub={w.connLimitEnabled ? `limit ${w.maxConnections} (enforced)` : "no limit"} />
        <Stat label="Unique source IPs" value={w.live?.uniqueIps ?? "—"} sub="IPs ≠ people (NAT/shared IPs)" />
        <Stat label="Connection attempts" value={w.live?.attempts ?? "—"} sub="new TCP conns since rules built" />
        <Stat label="CPU (cgroup)" value={fmtPct(w.live?.cpuPercent)} sub={w.live?.cpuCorePercent != null ? `${w.live.cpuCorePercent.toFixed(1)}% of one core` : "not measurable"} />
        <Stat label="RAM (cgroup)" value={fmtBytes(w.live?.memBytes)} />
        <Stat label="Bandwidth now" value={<span className="text-base">↓ {fmtRate(w.live?.txRate)}<br />↑ {fmtRate(w.live?.rxRate)}</span>} sub={`total ${fmtBytes(w.trafficRxBytes + w.trafficTxBytes)}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connection details">
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">Server</dt><dd className="mono">{data.links?.host ?? "unknown (set public host in Settings)"}</dd>
            <dt className="text-slate-500">Port</dt><dd className="mono">{w.port}</dd>
            {w.mode === "faketls" && <><dt className="text-slate-500">Fake-TLS domain</dt><dd className="mono">{w.tlsDomain}</dd></>}
            <dt className="text-slate-500">Secret</dt>
            <dd className="mono break-all">{secret ? <>{secret.clientSecret}<div className="text-xs text-slate-400">raw: {secret.secret}</div></> : <>{w.secretMasked} <button className="text-xs text-sky-600" onClick={async () => setSecret(await api(`/api/workers/${w.id}/secret`))}>reveal</button></>}</dd>
            <dt className="text-slate-500">EPOLL</dt><dd>{w.epollStatus} <span className="text-xs text-slate-400">(MTProxy uses epoll internally; not a configurable option – verified via /proc fd inspection)</span></dd>
            <dt className="text-slate-500">Restarts</dt><dd>{w.restartCount}</dd>
          </dl>
          {data.links?.https && (
            <div className="mt-4 space-y-2">
              <div className="mono break-all rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{data.links.https}</div>
              <div className="flex gap-2">
                <Button size="sm" onClick={async () => { await copyText(data.links!.https!); toast("success", "Link copied"); }}>Copy t.me link</Button>
                <Button size="sm" variant="secondary" onClick={async () => { await copyText(data.links!.tg!); toast("success", "tg:// link copied"); }}>Copy tg:// link</Button>
              </div>
              <p className="text-xs text-slate-500">Verify by opening the link in a real Telegram client – the panel verifies the service and port, but only a Telegram client can confirm end-to-end MTProto connectivity.</p>
            </div>
          )}
        </Card>
        <SponsorPanel w={w} track={track} />
      </div>

      <EditPanel w={w} track={track} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top source IPs (current connections)">
          {!w.live?.topIps.length ? <div className="text-sm text-slate-500">No established connections.</div> : (
            <table className="w-full text-sm"><tbody>{w.live.topIps.map((t) => <tr key={t.ip} className="border-b border-slate-100 dark:border-slate-800"><td className="mono py-1">{t.ip}</td><td className="text-right">{t.count} conn</td></tr>)}</tbody></table>
          )}
          <p className="mt-2 text-xs text-slate-500">Source IPs are network addresses, not Telegram accounts. Several users may share one IP (NAT/mobile carriers).</p>
        </Card>
        <Card title="Active protection restrictions" actions={w.restrictions.length > 0 && <Button size="sm" variant="secondary" onClick={() => track("Restore", api("/api/protection/restore", { method: "POST", json: { workerId: w.id } }).then(() => ({ jobId: null })))}>Restore original settings</Button>}>
          {!w.restrictions.length ? <div className="text-sm text-slate-500">None – worker runs with its configured limits.</div> : (
            <ul className="space-y-1 text-sm">{w.restrictions.map((r) => <li key={r.id}><Badge color="amber">stage {r.stage}</Badge> {r.kind} {JSON.stringify(r.value)} {r.target} <span className="text-xs text-slate-500">{r.reason}</span></li>)}</ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="CPU % (6h)"><Sparkline values={(hist.data?.resources || []).map((r) => r.cpuPercent ?? 0)} max={10} /></Card>
        <Card title="Connections (6h)"><Sparkline values={(hist.data?.connections || []).map((r) => r.activeConnections)} max={10} color="#7c3aed" /></Card>
        <Card title="Download rate (6h)"><Sparkline values={(hist.data?.bandwidth || []).map((r) => r.txRate)} max={1} color="#059669" /></Card>
      </div>

      <Card title="Network rule enforcement (actual state from the host helper)">
        {!w.netStatus ? <div className="text-sm text-slate-500">Network rules have not been applied yet.</div> : (
          <div className="space-y-1 text-sm">
            <div className="mb-2">{w.netStatus.enforced ? <Badge color="green">all components enforced</Badge> : w.netStatus.partial ? <Badge color="amber">partially enforced – some limits are NOT active</Badge> : <Badge color="red">failed – limits are NOT active</Badge>}
              <span className="ml-2 text-xs text-slate-500">checked {timeAgo(w.netStatus.at)} · helper exit {w.netStatus.exitCode ?? "—"}</span></div>
            <table className="w-full max-w-xl text-sm"><tbody>
              {Object.entries(w.netStatus.components).filter(([k]) => !["id", "port"].includes(k)).map(([k, v]) => (
                <tr key={k} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1 pr-3 font-medium">{k}</td>
                  <td><Badge color={v === "ok" || v === "off" ? "green" : v === "skipped" ? "gray" : "red"}>{v}</Badge></td></tr>
              ))}
            </tbody></table>
            {w.netStatus.error && <div className="mt-2 text-xs text-rose-600">{w.netStatus.error}</div>}
            <p className="mt-2 text-xs text-slate-500">tc_v4/tc_v6 = client download shaping · ifb_v4/ifb_v6 = client upload shaping (needs the ifb device) · nft_global = per-worker global connection limit, one counter shared by IPv4+IPv6 (fallback-iptables-per-family = per-family counters only: combined IPv4+IPv6 may exceed TOTAL, shown as partial, never as enforced) · ip4_fw/ip6_fw = per-IP connlimit and IP blocks. A component shown as failed/unavailable is <b>not</b> enforced.</p>
          </div>
        )}
      </Card>

      <Card title="Configuration history">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500"><tr><th className="text-left">Version</th><th className="text-left">Config</th><th className="text-left">Applied</th><th className="text-left">Date</th></tr></thead>
          <tbody>{data.configs.map((c) => <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1">v{c.version}</td><td className="mono text-xs">{JSON.stringify(c.config)}</td><td>{c.appliedOk == null ? <Badge>pending</Badge> : c.appliedOk ? <Badge color="green">ok</Badge> : <Badge color="red">rolled back</Badge>}</td><td className="text-xs">{fmtDate(c.createdAt)}</td></tr>)}</tbody>
        </table>
      </Card>
      <LogsModal worker={showLogs ? w : null} onClose={() => setShowLogs(false)} />
    </div>
  );
}

function SponsorPanel({ w, track }: { w: WorkerDTO; track: (l: string, p: Promise<{ jobId: string | null }>) => Promise<void> }) {
  const { data, reload } = usePoll<Sponsor>(`/api/workers/${w.id}/sponsor`, 0);
  const [tag, setTag] = useState("");
  const { toast } = useUI();
  useEffect(() => { reload(); }, [w.sponsorState, reload]);
  const post = (label: string, json: unknown) => track(label, api(`/api/workers/${w.id}/sponsor`, { method: "POST", json }));
  return (
    <Card title="Sponsorship (@MTProxybot)">
      <div className="mb-3 flex items-center gap-2 text-sm">Status: <Badge color={(SPONSOR_LABEL[w.sponsorState] || SPONSOR_LABEL.none).color}>{(SPONSOR_LABEL[w.sponsorState] || SPONSOR_LABEL.none).label}</Badge>
        {w.sponsorState === "active" && <span className="text-xs text-slate-500">{w.sponsorVerifiedAt ? `tag applied & service verified ${timeAgo(w.sponsorVerifiedAt)}` : "applying…"}</span>}
      </div>
      {w.sponsorState === "none" && (
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p>The proxy runs normally without registration. To show a sponsored channel to users, register it with Telegram&apos;s official @MTProxybot.</p>
          <Button size="sm" onClick={() => post("Start registration", { action: "request" })}>Register with @MTProxybot</Button>
        </div>
      )}
      {(w.sponsorState === "waiting" || w.sponsorState === "active") && data && (
        <div className="space-y-3 text-sm">
          {w.sponsorState === "waiting" && (
            <ol className="list-decimal space-y-1 pl-5 text-slate-600 dark:text-slate-300">
              <li>Open <a href={data.registration.bot} target="_blank" rel="noreferrer" className="text-sky-600 underline">@MTProxybot</a> and send <code>/newproxy</code>.</li>
              <li>Send the server address: <code className="mono">{data.registration.hostPort ?? "public IP unknown"}</code> {data.registration.hostPort && <button className="text-xs text-sky-600" onClick={async () => { await copyText(data.registration.hostPort!); toast("success", "Copied"); }}>copy</button>}</li>
              <li>Send the secret (hex): <code className="mono break-all">{data.registration.secret}</code> <button className="text-xs text-sky-600" onClick={async () => { await copyText(data.registration.secret); toast("success", "Copied"); }}>copy</button></li>
              <li>The bot replies with a <b>proxy tag</b>. Paste it below. You can leave and come back later – the worker keeps running unsponsored meanwhile.</li>
            </ol>
          )}
          <div className="flex gap-2">
            <input className={`${inputCls} mono`} placeholder="32-character hex tag from @MTProxybot" value={tag} onChange={(e) => setTag(e.target.value)} />
            <Button onClick={() => { if (!/^[0-9a-fA-F]{32}$/.test(tag.trim())) return toast("error", "Tag must be 32 hex characters"); post("Apply sponsor tag", { action: "activate", tag: tag.trim() }); setTag(""); }}>{w.sponsorState === "active" ? "Replace tag" : "Apply tag"}</Button>
          </div>
          <div className="flex gap-2">
            {w.sponsorState === "active" && <Button size="sm" variant="secondary" onClick={() => post("Re-register", { action: "request" })}>Back to waiting</Button>}
            <Button size="sm" variant="ghost" onClick={() => post("Remove sponsorship", { action: "none" })}>Remove sponsorship</Button>
          </div>
          <p className="text-xs text-slate-500">The tag is passed to MTProxy with <code>-P</code> and the worker is restarted and re-verified. Tags are stored encrypted. The panel never invents tags; Telegram-side status is visible in @MTProxybot.</p>
        </div>
      )}
    </Card>
  );
}

function EditPanel({ w, track }: { w: WorkerDTO; track: (l: string, p: Promise<{ jobId: string | null }>) => Promise<void> }) {
  const init = () => ({ name: w.name, port: String(w.port), mode: w.mode, tlsDomain: w.tlsDomain || "www.cloudflare.com", maxConnections: w.maxConnections ? String(w.maxConnections) : "", connLimitEnabled: w.connLimitEnabled, downloadKbps: w.downloadKbps ? String(w.downloadKbps) : "", uploadKbps: w.uploadKbps ? String(w.uploadKbps) : "", bwLimitEnabled: w.bwLimitEnabled, autoRestart: w.autoRestart, regenerateSecret: false });
  const [f, setF] = useState(init);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setF(init()); }, [w, dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: unknown) => { setDirty(true); setF((x) => ({ ...x, [k]: v })); };
  const save = async () => {
    const body: Record<string, unknown> = { ...f, port: Number(f.port), maxConnections: f.maxConnections || null, downloadKbps: f.downloadKbps || null, uploadKbps: f.uploadKbps || null };
    if (f.mode !== "faketls") delete body.tlsDomain;
    await track("Save configuration", api(`/api/workers/${w.id}`, { method: "PATCH", json: body }));
    setDirty(false);
  };
  return (
    <Card title="Edit worker" actions={dirty && <><Button size="sm" variant="ghost" onClick={() => { setDirty(false); setF(init()); }}>Reset</Button><Button size="sm" onClick={save}>Save</Button></>}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Name"><input className={inputCls} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Port" hint="Changing requires restart (auto rollback on failure)"><input className={inputCls} type="number" value={f.port} onChange={(e) => set("port", e.target.value)} /></Field>
        <Field label="Mode">
          <select className={inputCls} value={f.mode} onChange={(e) => set("mode", e.target.value)}>
            <option value="classic">Standard MTProto</option><option value="secure">Random padding (dd)</option><option value="faketls">Fake-TLS (ee)</option>
          </select>
        </Field>
        {f.mode === "faketls" && <Field label="Fake-TLS domain"><input className={inputCls} value={f.tlsDomain} onChange={(e) => set("tlsDomain", e.target.value)} /></Field>}
        <div className="space-y-2">
          <Toggle checked={f.connLimitEnabled} onChange={(v) => set("connLimitEnabled", v)} label="Connection limit" />
          <input className={inputCls} type="number" placeholder="max concurrent" value={f.maxConnections} onChange={(e) => set("maxConnections", e.target.value)} />
        </div>
        <div className="space-y-2">
          <Toggle checked={f.bwLimitEnabled} onChange={(v) => set("bwLimitEnabled", v)} label={`Bandwidth limit (now ↓${fmtKbps(w.bwLimitEnabled ? w.downloadKbps : null)} ↑${fmtKbps(w.bwLimitEnabled ? w.uploadKbps : null)})`} />
          <div className="flex gap-2">
            <input className={inputCls} type="number" placeholder="↓ kbit/s" value={f.downloadKbps} onChange={(e) => set("downloadKbps", e.target.value)} />
            <input className={inputCls} type="number" placeholder="↑ kbit/s" value={f.uploadKbps} onChange={(e) => set("uploadKbps", e.target.value)} />
          </div>
        </div>
        <Toggle checked={f.autoRestart} onChange={(v) => set("autoRestart", v)} label="Auto-restart on health failure (bounded)" />
        <Toggle checked={f.regenerateSecret} onChange={(v) => set("regenerateSecret", v)} label="Rotate secret (invalidates existing links)" />
      </div>
      <p className="mt-3 text-xs text-slate-500">Bandwidth and connection limits are applied live (tc / iptables) without restarting. Port, mode, domain and secret changes restart the worker; if verification fails the previous configuration is restored automatically.</p>
    </Card>
  );
}
