"use client";

import { useEffect, useState } from "react";
import { api, Badge, Bar, Button, Card, ErrorBox, Field, fmtDate, fmtPct, inputCls, Loading, Sparkline, Stat, Toggle, usePoll, useUI } from "@/components/ui";
import { STAGE_LABEL } from "@/components/labels";

type Cfg = Record<string, number | boolean | string>;
type Resp = {
  config: Cfg; defaults: Cfg;
  state: { stage: number; cpu: number | null; secondsAbove: number; secondsBelow: number; recoveryProgress: number | null; lastEscalationAt: number | null };
  cpuHistory: { ts: number; cpu: number }[];
  restrictions: { id: number; workerId: number | null; workerName: string | null; kind: string; stage: number; value: Record<string, number>; target: string | null; reason: string | null; createdAt: string; expiresAt: string | null }[];
  events: { id: number; ts: string; type: string; stage: number; cpuPercent: number | null; message: string }[];
};

const FIELDS: [string, string, string][] = [
  ["triggerPercent", "Trigger threshold (%)", "CPU must stay at or above this"],
  ["triggerSeconds", "Trigger duration (s)", "continuous seconds above threshold"],
  ["recoveryPercent", "Recovery threshold (%)", "CPU must stay below this"],
  ["recoverySeconds", "Recovery duration (s)", "per restoration step"],
  ["escalateSeconds", "Escalation interval (s)", "between stages while overloaded"],
  ["maxStage", "Maximum stage (2-4)", "highest stage allowed"],
  ["topWorkers", "Workers to restrict", "highest CPU consumers"],
  ["stage2BandwidthFactor", "Stage 2 bandwidth factor", "0.5 = halve current limit/rate"],
  ["stage2MinKbps", "Minimum bandwidth (kbit/s)", "never limit below"],
  ["stage3PerIpConnLimit", "Stage 3 per-IP conn limit", "new conns beyond are rejected"],
  ["stage3IpBlockThreshold", "Stage 3 IP block threshold", "concurrent conns from ONE IP"],
  ["stage3IpBlockMinutes", "IP block duration (min)", "temporary"],
  ["stage4BandwidthFactor", "Stage 4 bandwidth factor", "emergency cap"],
  ["stage4CpuQuotaPercent", "Stage 4 CPUQuota (%)", "systemd/cgroup, 100 = 1 core"],
];

export default function ProtectionPage() {
  const { data, error, loading, reload } = usePoll<Resp>("/api/protection", 1500);
  const { toast, confirm } = useUI();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (data && !dirty) setCfg(data.config); }, [data, dirty]);
  if (loading && !data) return <Loading />;
  if (!data || !cfg) return <ErrorBox error={error} />;
  const s = data.state;
  const c = data.config;
  const save = async (next: Cfg) => {
    try {
      await api("/api/protection", { method: "PATCH", json: next });
      toast("success", "Protection settings saved");
      setDirty(false);
      reload();
    } catch (e) { toast("error", (e as Error).message); }
  };
  const restoreAll = async () => {
    if (!(await confirm({ title: "Restore all workers?", body: "All automatic restrictions will be lifted immediately and protection state reset to Normal." }))) return;
    try { const r = await api<{ lifted: number }>("/api/protection/restore", { method: "POST", json: {} }); toast("success", `${r.lifted} restriction(s) lifted`); reload(); } catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Automatic CPU Protection</h1>
        <div className="flex items-center gap-3">
          <Toggle checked={!!c.enabled} onChange={(v) => save({ ...c, enabled: v })} label={c.enabled ? "Enabled" : "Disabled"} />
          <Button variant="secondary" onClick={restoreAll}>Manual restore all</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Current state" value={<Badge color={!c.enabled ? "gray" : s.stage === 0 ? "green" : s.stage >= 4 ? "red" : "amber"}>{!c.enabled ? "Disabled" : STAGE_LABEL[s.stage]}</Badge>} />
        <Stat label="Global CPU" value={fmtPct(s.cpu)} tone={s.cpu != null && s.cpu >= Number(c.triggerPercent) ? "bad" : "good"} big />
        <Stat label="Trigger" value={`${c.triggerPercent}% · ${c.triggerSeconds}s`} sub={`recovery < ${c.recoveryPercent}% for ${c.recoverySeconds}s`} />
        <Stat label="Time above threshold" value={`${s.secondsAbove.toFixed(0)}s`} sub={s.secondsAbove > 0 ? <Bar value={(s.secondsAbove / Number(c.triggerSeconds)) * 100} tone="bg-rose-500" /> : "continuous"} />
        <Stat label="Recovery progress" value={s.recoveryProgress != null ? `${Math.round(s.recoveryProgress * 100)}%` : "—"} sub={s.recoveryProgress != null ? <Bar value={s.recoveryProgress * 100} tone="bg-emerald-500" /> : "not in protection"} />
      </div>
      <Card title="Global CPU (last 2 minutes, 1s samples)"><Sparkline values={data.cpuHistory.map((h) => h.cpu)} threshold={Number(c.triggerPercent)} height={100} /></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Affected workers & applied restrictions (${data.restrictions.length})`}>
          {!data.restrictions.length ? <div className="text-sm text-slate-500">No active restrictions.</div> : (
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500"><tr><th className="text-left">Worker</th><th className="text-left">Stage</th><th className="text-left">Restriction</th><th></th></tr></thead>
              <tbody>{data.restrictions.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5">#{r.workerId} {r.workerName}</td>
                  <td><Badge color="amber">{r.stage}</Badge></td>
                  <td className="text-xs">{r.kind === "bandwidth" ? `↓${r.value.downKbps} / ↑${r.value.upKbps} kbit/s` : r.kind === "conn_per_ip" ? `${r.value.limit} conns per IP` : r.kind === "ip_block" ? `block ${r.target} until ${fmtDate(r.expiresAt)}` : `CPUQuota ${r.value.percent}%`}<div className="text-slate-400">{r.reason}</div></td>
                  <td>{r.workerId && <Button size="sm" variant="ghost" onClick={async () => { await api("/api/protection/restore", { method: "POST", json: { workerId: r.workerId } }); toast("success", "Restored"); reload(); }}>Restore</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="How it works">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li><b>Analyze</b> – after CPU ≥ {String(c.triggerPercent)}% continuously for {String(c.triggerSeconds)}s, the highest cgroup-measured worker consumers are identified. Short spikes reset the timer.</li>
            <li><b>Reduce speed</b> – temporary tc bandwidth caps on the top {String(c.topWorkers)} worker(s).</li>
            <li><b>Restrict connections</b> – per-source-IP connlimit on new connections; optional temporary IP blocks only for single IPs above {String(c.stage3IpBlockThreshold)} concurrent connections ({c.stage3IpBlockEnabled ? "enabled" : "disabled"}). Shared/NAT IPs are why this is off by default.</li>
            <li><b>Emergency</b> – cgroup CPUQuota and stronger bandwidth caps on top workers. The panel, database and monitoring are never restricted; the VPS is never shut down.</li>
            <li><b>Recovery</b> – after CPU &lt; {String(c.recoveryPercent)}% for {String(c.recoverySeconds)}s, restrictions are lifted one stage at a time until original limits are restored.</li>
          </ol>
        </Card>
      </div>
      <Card title="Thresholds & restriction levels" actions={dirty && <><Button size="sm" variant="ghost" onClick={() => { setDirty(false); setCfg(c); }}>Reset</Button><Button size="sm" onClick={() => save(cfg)}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FIELDS.map(([k, label, hint]) => (
            <Field key={k} label={label} hint={`${hint} · default ${data.defaults[k]}`}>
              <input className={inputCls} type="number" step="any" value={String(cfg[k])} onChange={(e) => { setDirty(true); setCfg({ ...cfg, [k]: e.target.value }); }} />
            </Field>
          ))}
          <div className="flex items-end"><Toggle checked={!!cfg.stage3IpBlockEnabled} onChange={(v) => { setDirty(true); setCfg({ ...cfg, stage3IpBlockEnabled: v }); }} label="Allow temporary IP blocks (stage 3)" /></div>
        </div>
      </Card>
      <Card title="Protection event history">
        {!data.events.length ? <div className="text-sm text-slate-500">No events recorded.</div> : (
          <div className="max-h-[480px] overflow-y-auto">
            <table className="w-full text-sm">
              <tbody>{data.events.map((e) => (
                <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-slate-500">{fmtDate(e.ts)}</td>
                  <td className="pr-3"><Badge color={e.type === "error" ? "red" : e.type === "recover" || e.type === "restore" ? "green" : e.type === "manual" ? "blue" : "amber"}>{e.type}</Badge></td>
                  <td className="pr-3 text-xs">stage {e.stage}</td>
                  <td className="pr-3 text-xs tabular-nums">{fmtPct(e.cpuPercent)}</td>
                  <td>{e.message}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
