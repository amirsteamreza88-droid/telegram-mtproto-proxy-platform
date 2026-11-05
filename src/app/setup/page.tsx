"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, Button, ErrorBox, Field, inputCls } from "@/components/ui";

export default function SetupPage() {
  const router = useRouter();
  const [u, setU] = useState("admin");
  const [p, setP] = useState("");
  const [p2, setP2] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ needsSetup: boolean }>("/api/auth/setup").then((r) => !r.needsSetup && router.replace("/login")).catch(() => {});
  }, [router]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (p !== p2) return setErr("Passwords do not match");
    setBusy(true);
    setErr(null);
    try {
      await api("/api/auth/setup", { method: "POST", json: { username: u, password: p, token: token || undefined } });
      router.push("/");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h1 className="text-xl font-semibold">Create administrator</h1>
          <p className="mt-1 text-sm text-slate-500">First-run setup. This page is disabled permanently once an administrator exists. (The installer normally creates the admin for you.)</p>
        </div>
        <ErrorBox error={err} />
        <Field label="Username"><input className={inputCls} value={u} onChange={(e) => setU(e.target.value)} required /></Field>
        <Field label="Password" hint="Minimum 12 characters"><input className={inputCls} type="password" value={p} onChange={(e) => setP(e.target.value)} required minLength={12} /></Field>
        <Field label="Confirm password"><input className={inputCls} type="password" value={p2} onChange={(e) => setP2(e.target.value)} required /></Field>
        <Field label="Setup token (if SETUP_TOKEN is configured)"><input className={inputCls} value={token} onChange={(e) => setToken(e.target.value)} /></Field>
        <Button className="w-full" disabled={busy}>{busy ? "Creating…" : "Create administrator"}</Button>
      </form>
    </div>
  );
}
