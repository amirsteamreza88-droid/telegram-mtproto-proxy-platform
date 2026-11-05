"use client";

import { Bar, Card, ErrorBox, fmtBytes, fmtPct, fmtRate, fmtUptime, Loading, Sparkline, Stat, usePoll } from "@/components/ui";
import type { WorkerDTO } from "@/components/types";

type Ov = { system: { cpu: number | null; cores: number[]; cpuHistory: { cpu: number }[]; mem: { total: number; available: number; used: number } | null; load: number[] | null; disk: { total: number; free: number; used: number } | null; uptime: number; netRate: { rx: number; tx: number }; ncpu: number } };
type Hist = { rows: { ts: string; cpuPercent: number | null; memBytes: number | null; extra: { load?: number[]; netRate?: { rx: number; tx: number } } | null }[] };

export default function MonitoringPage() {
  const ov = usePoll<Ov>("/api/overview", 2000);
  const ws = usePoll<{ workers: WorkerDTO[] }>("/api/workers", 5000);
  const hist = usePoll<Hist>("/api/system/history?hours=24", 60000);
  if (ov.loading && !ov.data) return <Loading />;
  if (!ov.data) return <ErrorBox error={ov.error} />;
  const s = ov.data.system;
  const rows = hist.data?.rows || [];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Resource Monitoring</h1>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <Stat label="Total CPU" value={fmtPct(s.cpu)} />
        <Stat label="Load average" value={s.load ? s.load.map((x) => x.toFixed(2)).join(" / ") : "—"} sub={`${s.ncpu} cores`} />
        <Stat label="RAM total" value={fmtBytes(s.mem?.total)} />
        <Stat label="RAM available" value={fmtBytes(s.mem?.available)} />
        <Stat label="Disk used" value={s.disk ? fmtPct((s.disk.used / s.disk.total) * 100) : "—"} sub={s.disk ? `${fmtBytes(s.disk.free)} free` : undefined} />
        <Stat label="Uptime" value={fmtUptime(s.uptime)} sub={`↓ ${fmtRate(s.netRate.rx)} ↑ ${fmtRate(s.netRate.tx)}`} />
      </div>
      <Card title="CPU per core (live)">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {s.cores.map((c, i) => <div key={i}><div className="mb-1 flex justify-between text-xs"><span>cpu{i}</span><span className="tabular-nums">{c.toFixed(1)}%</span></div><Bar value={c} /></div>)}
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="CPU % (24h, 30s averages)"><Sparkline values={rows.map((r) => r.cpuPercent ?? 0)} /></Card>
        <Card title="RAM used (24h)"><Sparkline values={rows.map((r) => r.memBytes ?? 0)} max={s.mem?.total || 1} color="#7c3aed" /></Card>
        <Card title="Network RX (24h)"><Sparkline values={rows.map((r) => r.extra?.netRate?.rx ?? 0)} max={1} color="#059669" /></Card>
      </div>
      <Card title="Per-worker resource accounting (cgroup v2)">
        {!ws.data?.workers.length ? <div className="text-sm text-slate-500">No workers.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 text-left">Worker</th><th className="text-left">CPU (of machine)</th><th className="text-left">CPU (of 1 core)</th><th className="text-left">RAM</th><th className="text-left">Connections</th><th className="text-left">↓ / ↑</th></tr></thead>
              <tbody>{ws.data.workers.map((w) => (
                <tr key={w.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5">#{w.id} {w.name}</td>
                  <td className="w-48"><div className="flex items-center gap-2"><Bar value={w.live?.cpuPercent ?? 0} /><span className="w-14 text-xs tabular-nums">{fmtPct(w.live?.cpuPercent)}</span></div></td>
                  <td className="tabular-nums">{fmtPct(w.live?.cpuCorePercent)}</td>
                  <td className="tabular-nums">{fmtBytes(w.live?.memBytes)}</td>
                  <td>{w.live?.connections ?? "—"}</td>
                  <td className="text-xs">{fmtRate(w.live?.txRate)} / {fmtRate(w.live?.rxRate)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">&quot;—&quot; means the value is not measurable (e.g. the worker&apos;s cgroup does not exist because the service is stopped or the panel isn&apos;t running on the managed host). Values are never estimated.</p>
      </Card>
    </div>
  );
}
