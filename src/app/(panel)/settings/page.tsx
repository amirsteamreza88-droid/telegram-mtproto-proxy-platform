"use client";

import { useEffect, useState } from "react";
import { api, Badge, Button, Card, ErrorBox, Field, inputCls, Loading, Toggle, usePoll, useUI } from "@/components/ui";

type S = { publicHost: string; defaultFakeTlsDomain: string; reservedPorts: number[]; healthAutoRestart: boolean; maxAutoRestartsPerHour: number; statsRetentionDays: number; backupEnabled: boolean; backupIntervalHours: number; backupKeep: number };
type D = { checks: { name: string; ok: boolean | null; detail: string }[]; listeningPorts: number[]; node: string };

export default function SettingsPage() {
  const { data, error, loading, reload } = usePoll<{ settings: S; detectedPublicIp: string | null }>("/api/settings", 0);
  const diag = usePoll<D>("/api/diagnostics", 0);
  const { toast, confirm } = useUI();
  const [s, setS] = useState<S | null>(null);
  const [ports, setPorts] = useState("");
  const [pw, setPw] = useState({ current: "", next: "" });
  useEffect(() => { if (data) { setS(data.settings); setPorts(data.settings.reservedPorts.join(", ")); } }, [data]);
  if (loading && !data) return <Loading />;
  if (!s) return <ErrorBox error={error} />;
  const set = (k: keyof S, v: unknown) => setS({ ...s, [k]: v });
  const save = async () => {
    try {
      await api("/api/settings", { method: "PATCH", json: { ...s, reservedPorts: ports.split(/[\s,]+/).filter(Boolean).map(Number) } });
      toast("success", "Settings saved");
      reload();
    } catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Card title="General" actions={<Button size="sm" onClick={save}>Save</Button>}>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Field label="Public host for proxy links" hint={`Empty = auto-detect (detected: ${data?.detectedPublicIp ?? "unknown"})`}><input className={inputCls} value={s.publicHost} onChange={(e) => set("publicHost", e.target.value)} placeholder="auto" /></Field>
          <Field label="Default Fake-TLS domain"><input className={inputCls} value={s.defaultFakeTlsDomain} onChange={(e) => set("defaultFakeTlsDomain", e.target.value)} /></Field>
          <Field label="Reserved ports" hint="Never assigned to workers (SSH, dashboard, DB, backend)"><input className={inputCls} value={ports} onChange={(e) => setPorts(e.target.value)} /></Field>
          <Field label="Max automatic restarts per worker per hour"><input className={inputCls} type="number" value={s.maxAutoRestartsPerHour} onChange={(e) => set("maxAutoRestartsPerHour", Number(e.target.value))} /></Field>
          <Field label="Statistics retention (days)"><input className={inputCls} type="number" value={s.statsRetentionDays} onChange={(e) => set("statsRetentionDays", Number(e.target.value))} /></Field>
          <div className="flex items-end"><Toggle checked={s.healthAutoRestart} onChange={(v) => set("healthAutoRestart", v)} label="Health monitor auto-restart (bounded)" /></div>
        </div>
      </Card>
      <Card title="Scheduled backups" actions={<Button size="sm" onClick={save}>Save</Button>}>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex items-end"><Toggle checked={s.backupEnabled} onChange={(v) => set("backupEnabled", v)} label="Enable scheduled backups" /></div>
          <Field label="Interval (hours)"><input className={inputCls} type="number" value={s.backupIntervalHours} onChange={(e) => set("backupIntervalHours", Number(e.target.value))} /></Field>
          <Field label="Keep last N scheduled backups"><input className={inputCls} type="number" value={s.backupKeep} onChange={(e) => set("backupKeep", Number(e.target.value))} /></Field>
        </div>
      </Card>
      <Card title="Change password">
        <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
          <input className={inputCls} type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <input className={inputCls} type="password" placeholder="New password (12+ chars)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <Button onClick={async () => { try { await api("/api/auth/password", { method: "POST", json: pw }); toast("success", "Password changed – please sign in again"); window.location.href = "/login"; } catch (e) { toast("error", (e as Error).message); } }}>Change</Button>
        </div>
      </Card>
      <Card title="Installation diagnostics" actions={<>
        <Button size="sm" variant="secondary" onClick={() => diag.reload()}>Re-run</Button>
        <Button size="sm" variant="secondary" onClick={async () => {
          if (!(await confirm({ title: "Re-sync host services?", body: "Every worker's systemd service, configuration and network rules are rebuilt from the database. Running workers restart briefly." }))) return;
          try { await api("/api/system/sync", { method: "POST" }); toast("info", "Host sync queued – see Background Jobs"); } catch (e) { toast("error", (e as Error).message); }
        }}>Re-sync host</Button>
      </>}>
        {diag.loading && !diag.data ? <Loading /> : (
          <>
            <table className="w-full text-sm"><tbody>{diag.data?.checks.map((c) => (
              <tr key={c.name} className="border-t border-slate-100 dark:border-slate-800">
                <td className="w-24 py-1.5"><Badge color={c.ok === true ? "green" : c.ok === false ? "red" : "amber"}>{c.ok === true ? "OK" : c.ok === false ? "FAIL" : "WARN"}</Badge></td>
                <td className="pr-3 font-medium">{c.name}</td><td className="text-xs text-slate-500">{c.detail}</td>
              </tr>
            ))}</tbody></table>
            <div className="mt-3 text-xs text-slate-500">Node {diag.data?.node} · listening TCP ports: {diag.data?.listeningPorts.join(", ")}</div>
          </>
        )}
      </Card>
    </div>
  );
}
