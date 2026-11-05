"use client";

import { useRef, useState } from "react";
import { api, Badge, Button, Card, Empty, ErrorBox, fmtBytes, fmtDate, Loading, StatusBadge, usePoll, useUI } from "@/components/ui";
import { watchJob } from "@/components/jobs";

type B = { id: number; filename: string; kind: string; status: string; sizeBytes: number | null; sha256: string | null; error: string | null; validatedAt: string | null; createdAt: string };

export default function BackupsPage() {
  const { data, error, loading, reload } = usePoll<{ backups: B[] }>("/api/backups", 5000);
  const { toast, confirm } = useUI();
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const job = async (label: string, p: Promise<{ jobId: string }>) => {
    setBusy(label);
    try {
      const { jobId } = await p;
      const j = await watchJob(jobId, (_x, s) => setBusy(s || label), 600000);
      j.status === "succeeded" ? toast("success", `${label} completed`) : toast("error", `${label} failed: ${j.error}`);
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(null); reload(); }
  };
  const upload = async (f: File) => {
    setBusy("Uploading");
    try {
      const res = await fetch("/api/backups/upload", { method: "POST", body: await f.arrayBuffer() });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      toast("success", "Backup uploaded and validated");
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(null); reload(); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Backup & Recovery</h1>
        <div className="flex gap-2">
          {busy && <span className="self-center text-sm text-sky-600">{busy}…</span>}
          <input ref={file} type="file" accept=".mtpb" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <Button variant="secondary" disabled={!!busy} onClick={() => file.current?.click()}>Upload backup</Button>
          <Button disabled={!!busy} onClick={() => job("Backup", api("/api/backups", { method: "POST" }))}>Create backup now</Button>
        </div>
      </div>
      <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
        Backups contain all configuration (admins, settings, workers, secrets, sponsorship tags, restrictions, events, audit log), compressed and encrypted with AES-256-GCM using this server&apos;s <code>APP_SECRET_KEY</code>. Keep a copy of that key (in <code>/etc/mtpanel/panel.env</code>) – without it a backup cannot be restored on another server. Scheduled backups are configured in Settings.
      </div>
      <Card>
        <ErrorBox error={error} />
        {loading && !data ? <Loading /> : !data?.backups.length ? <Empty title="No backups yet" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-xs uppercase text-slate-500"><tr>{["File", "Type", "Status", "Size", "Created", "Validated", ""].map((h) => <th key={h} className="py-2 text-left">{h}</th>)}</tr></thead>
              <tbody>{data.backups.map((b) => (
                <tr key={b.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="mono py-2 text-xs">{b.filename}{b.error && <div className="text-rose-600">{b.error}</div>}</td>
                  <td><Badge>{b.kind}</Badge></td>
                  <td><StatusBadge status={b.status} /></td>
                  <td>{fmtBytes(b.sizeBytes)}</td>
                  <td className="text-xs">{fmtDate(b.createdAt)}</td>
                  <td className="text-xs">{fmtDate(b.validatedAt)}</td>
                  <td className="whitespace-nowrap">{b.status === "ready" && (
                    <div className="flex gap-1">
                      <a href={`/api/backups/${b.id}/download`}><Button size="sm" variant="ghost">Download</Button></a>
                      <Button size="sm" variant="ghost" onClick={async () => { try { const r = await api<{ counts: Record<string, number> }>(`/api/backups/${b.id}/validate`, { method: "POST" }); toast("success", `Valid: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`); reload(); } catch (e) { toast("error", (e as Error).message); } }}>Validate</Button>
                      <Button size="sm" variant="danger" disabled={!!busy} onClick={async () => {
                        if (!(await confirm({ title: "Restore this backup?", body: "Current configuration is replaced (a safety backup is created first). All sessions are logged out and every worker is re-deployed to match the backup.", danger: true, confirmLabel: "Restore" }))) return;
                        job("Restore", api(`/api/backups/${b.id}/restore`, { method: "POST" }));
                      }}>Restore</Button>
                    </div>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
