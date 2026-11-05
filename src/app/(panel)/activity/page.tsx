"use client";

import { useState } from "react";
import { Badge, Card, Empty, ErrorBox, fmtDate, inputCls, Loading, usePoll } from "@/components/ui";

type L = { id: number; ts: string; actor: string; action: string; target: string | null; level: string; details: unknown; ip: string | null };

export default function ActivityPage() {
  const [q, setQ] = useState("");
  const [level, setLevel] = useState("");
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (level) params.set("level", level);
  const { data, error, loading } = usePoll<{ logs: L[] }>(`/api/activity?${params}`, 5000);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit Log</h1>
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className={`${inputCls} max-w-xs`} placeholder="Search action, actor, target…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={`${inputCls} max-w-[140px]`} value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">All levels</option><option>info</option><option>warn</option><option>error</option>
          </select>
        </div>
        <ErrorBox error={error} />
        {loading && !data ? <Loading /> : !data?.logs.length ? <Empty title="No log entries" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-sm">
              <thead className="text-xs uppercase text-slate-500"><tr>{["Time", "Level", "Actor", "Action", "Target", "Details", "IP"].map((h) => <th key={h} className="py-2 text-left">{h}</th>)}</tr></thead>
              <tbody>{data.logs.map((l) => (
                <tr key={l.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-slate-500">{fmtDate(l.ts)}</td>
                  <td className="pr-3"><Badge color={l.level === "error" ? "red" : l.level === "warn" ? "amber" : "gray"}>{l.level}</Badge></td>
                  <td className="pr-3">{l.actor}</td>
                  <td className="mono pr-3 text-xs">{l.action}</td>
                  <td className="pr-3 text-xs">{l.target}</td>
                  <td className="mono max-w-md truncate pr-3 text-xs text-slate-500" title={l.details ? JSON.stringify(l.details) : ""}>{l.details ? JSON.stringify(l.details) : ""}</td>
                  <td className="text-xs">{l.ip}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
