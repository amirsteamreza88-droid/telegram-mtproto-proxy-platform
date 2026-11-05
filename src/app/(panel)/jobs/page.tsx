"use client";

import { Fragment, useState } from "react";
import { api, Bar, Button, Card, Empty, ErrorBox, fmtDate, inputCls, Loading, StatusBadge, usePoll, useUI } from "@/components/ui";

type J = { id: string; type: string; payload: Record<string, unknown>; status: string; progress: number; step: string | null; attempts: number; maxAttempts: number; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null };

export default function JobsPage() {
  const [status, setStatus] = useState("");
  const { data, error, loading, reload } = usePoll<{ jobs: J[] }>(`/api/jobs${status ? `?status=${status}` : ""}`, 2000);
  const { toast } = useUI();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-xl font-semibold">Background Jobs</h1>
        <select className={`${inputCls} max-w-[180px]`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>{["queued", "running", "succeeded", "failed"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <Card>
        <ErrorBox error={error} />
        {loading && !data ? <Loading /> : !data?.jobs.length ? <Empty title="No jobs" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-xs uppercase text-slate-500"><tr>{["Job ID", "Type", "Status", "Progress", "Started", "Completed", ""].map((h) => <th key={h} className="py-2 text-left">{h}</th>)}</tr></thead>
              <tbody>{data.jobs.map((j) => (
                <Fragment key={j.id}>
                  <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40" onClick={() => setOpen(open === j.id ? null : j.id)}>
                    <td className="mono py-2 text-xs">{j.id.slice(0, 8)}</td>
                    <td>{j.type} <span className="text-xs text-slate-400">{j.payload.workerId ? `#${j.payload.workerId}` : ""}</span></td>
                    <td><StatusBadge status={j.status} /> {j.attempts > 1 && <span className="text-xs text-slate-400">try {j.attempts}/{j.maxAttempts}</span>}</td>
                    <td className="w-56"><Bar value={j.progress} tone={j.status === "failed" ? "bg-rose-500" : "bg-sky-500"} /><div className="mt-0.5 truncate text-xs text-slate-500">{j.step}</div></td>
                    <td className="text-xs">{fmtDate(j.startedAt)}</td>
                    <td className="text-xs">{fmtDate(j.finishedAt)}</td>
                    <td>{j.status === "failed" && <Button size="sm" variant="secondary" onClick={async (e) => { e.stopPropagation(); try { await api(`/api/jobs/${j.id}/retry`, { method: "POST" }); toast("success", "Retry queued"); reload(); } catch (er) { toast("error", (er as Error).message); } }}>Retry</Button>}</td>
                  </tr>
                  {open === j.id && <tr><td colSpan={7} className="bg-slate-50 p-3 dark:bg-slate-950"><div className="mono text-xs">id: {j.id}<br />created: {fmtDate(j.createdAt)}<br />payload: {JSON.stringify(j.payload)}</div>{j.error && <pre className="mono mt-2 whitespace-pre-wrap text-xs text-rose-600">{j.error}</pre>}</td></tr>}
                </Fragment>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
