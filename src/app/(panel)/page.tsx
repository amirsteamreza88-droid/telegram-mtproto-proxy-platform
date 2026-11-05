"use client";

import Link from "next/link";
import { STAGE_LABEL } from "@/components/labels";
import { Badge, Bar, Card, ErrorBox, fmtBytes, fmtDate, fmtPct, fmtRate, fmtUptime, Loading, Sparkline, Stat, usePoll } from "@/components/ui";

type Overview = {
  system: {
    cpu: number | null; cores: number[]; cpuHistory: { ts: number; cpu: number }[];
    mem: { total: number; available: number; used: number } | null; load: number[] | null;
    disk: { total: number; free: number; used: number } | null; uptime: number; netRate: { rx: number; tx: number }; ncpu: number; hostname: string;
  };
  workers: { total: number; active: number; offline: number; pending: number };
  connections: number | null;
  traffic: number;
  protection: { enabled: boolean; stage: number; aboveSince: number | null; triggerPercent: number; activeRestrictions: number; recentEvents: { id: number; ts: string; message: string; stage: number; type: string }[] };
  hostAgent: { ok: boolean; reason: string };
};


export default function Dashboard() {
  const { data, error, loading } = usePoll<Overview>("/api/overview", 2000);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const s = data.system;
  const memPct = s.mem ? (s.mem.used / s.mem.total) * 100 : null;
  const diskPct = s.disk ? (s.disk.used / s.disk.total) * 100 : null;
  const p = data.protection;
  return (
    <div className="space-y-5">
      <ErrorBox error={error} />
      {!data.hostAgent.ok && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <b>Host agent unavailable:</b> {data.hostAgent.reason}. System metrics below are real, but workers cannot be deployed or controlled until the panel runs on the installed Ubuntu host. <Link href="/settings" className="underline">Diagnostics</Link>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={<span>Global CPU usage <span className="font-normal text-slate-400">· {s.ncpu} cores · {s.hostname}</span></span>}>
          <div className="flex flex-wrap items-end gap-6">
            <div>
              <div className={`text-6xl font-bold tabular-nums ${s.cpu != null && s.cpu >= p.triggerPercent ? "text-rose-600" : s.cpu != null && s.cpu >= 70 ? "text-amber-500" : "text-emerald-600"}`}>{fmtPct(s.cpu)}</div>
              <div className="mt-1 text-xs text-slate-500">measured from /proc/stat every 1s · dashed line = protection trigger ({p.triggerPercent}%)</div>
            </div>
            <div className="min-w-[200px] flex-1"><Sparkline values={s.cpuHistory.map((h) => h.cpu)} threshold={p.triggerPercent} height={90} /></div>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-8">
            {s.cores.map((c, i) => (
              <div key={i}><div className="mb-1 flex justify-between text-[10px] text-slate-500"><span>cpu{i}</span><span>{c.toFixed(0)}%</span></div><Bar value={c} /></div>
            ))}
          </div>
        </Card>
        <Card title="Protection status" actions={<Link href="/protection" className="text-xs text-sky-600">Open →</Link>}>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge color={!p.enabled ? "gray" : p.stage === 0 ? "green" : p.stage >= 4 ? "red" : "amber"}>{!p.enabled ? "Disabled" : STAGE_LABEL[p.stage]}</Badge>
              {p.activeRestrictions > 0 && <Badge color="amber">{p.activeRestrictions} active restriction(s)</Badge>}
            </div>
            {p.aboveSince && <div className="text-sm text-rose-600">Above {p.triggerPercent}% for {((Date.now() - p.aboveSince) / 1000).toFixed(0)}s</div>}
            <div className="space-y-1.5">
              {p.recentEvents.length === 0 && <div className="text-sm text-slate-500">No protection events yet.</div>}
              {p.recentEvents.map((e) => (
                <div key={e.id} className="text-xs"><span className="text-slate-400">{fmtDate(e.ts)}</span> <span className="text-slate-700 dark:text-slate-300">{e.message}</span></div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Total workers" value={data.workers.total} sub={data.workers.pending ? `${data.workers.pending} deploying` : undefined} />
        <Stat label="Active workers" value={data.workers.active} tone="good" />
        <Stat label="Offline workers" value={data.workers.offline} tone={data.workers.offline ? "bad" : "default"} />
        <Stat label="Active connections" value={data.connections ?? "—"} sub="established TCP (/proc/net/tcp)" />
        <Stat label="Total traffic" value={fmtBytes(data.traffic)} sub="client traffic via tc" />
        <Stat label="RAM usage" value={fmtPct(memPct)} sub={s.mem ? `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}` : undefined} tone={memPct && memPct > 90 ? "bad" : "default"} />
        <Stat label="Server uptime" value={fmtUptime(s.uptime)} sub={s.load ? `load ${s.load.map((l) => l.toFixed(2)).join(" ")}` : undefined} />
        <Stat label="Network" value={<span className="text-base">↓ {fmtRate(s.netRate.rx)}<br />↑ {fmtRate(s.netRate.tx)}</span>} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Memory">
          <Bar value={memPct} />
          <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">{s.mem ? `${fmtBytes(s.mem.used)} used · ${fmtBytes(s.mem.available)} available of ${fmtBytes(s.mem.total)}` : "Not measurable"}</div>
        </Card>
        <Card title="Disk (/)">
          <Bar value={diskPct} />
          <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">{s.disk ? `${fmtBytes(s.disk.used)} used · ${fmtBytes(s.disk.free)} free of ${fmtBytes(s.disk.total)}` : "Not measurable"}</div>
        </Card>
      </div>
    </div>
  );
}
