"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// ---------- fetch helpers ----------
export async function api<T = unknown>(url: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = opts;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers || {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth")) {
    window.location.href = "/login";
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export function usePoll<T>(url: string | null, intervalMs = 3000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const urlRef = useRef(url);
  urlRef.current = url;
  const load = useCallback(async () => {
    if (!urlRef.current) return;
    try {
      const d = await api<T>(urlRef.current);
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!url) return;
    setLoading(true);
    load();
    if (!intervalMs) return;
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [url, intervalMs, load]);
  return { data, error, loading, reload: load };
}

// ---------- formatting ----------
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export function fmtRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null) return "—";
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbit/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbit/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kbit/s`;
  return `${bits.toFixed(0)} bit/s`;
}
export function fmtKbps(k: number | null | undefined): string {
  if (!k) return "Unlimited";
  return k >= 1000 ? `${(k / 1000).toFixed(k % 1000 ? 1 : 0)} Mbit/s` : `${k} kbit/s`;
}
export function fmtPct(n: number | null | undefined, d = 1): string {
  return n == null ? "—" : `${n.toFixed(d)}%`;
}
export function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
}
export function fmtDate(d: string | number | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}
export function timeAgo(d: string | Date | null | undefined): string {
  if (!d) return "never";
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------- primitives ----------
export function Card({ children, className = "", title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

export function Stat({ label, value, sub, tone = "default", big = false }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "default" | "good" | "warn" | "bad"; big?: boolean }) {
  const tones = { default: "text-slate-900 dark:text-white", good: "text-emerald-600 dark:text-emerald-400", warn: "text-amber-600 dark:text-amber-400", bad: "text-rose-600 dark:text-rose-400" };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 font-semibold ${big ? "text-4xl" : "text-2xl"} ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{sub}</div>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  red: "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  gray: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300",
  violet: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
};
export function Badge({ children, color = "gray" }: { children: ReactNode; color?: keyof typeof BADGE | string }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[color] || BADGE.gray}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const c: Record<string, string> = { active: "green", running: "green", succeeded: "green", ready: "green", stopped: "gray", pending: "blue", queued: "blue", deploying: "blue", creating: "blue", deleting: "amber", failed: "red", error: "red" };
  return <Badge color={c[status] || "gray"}>{status}</Badge>;
}

export function Button({ children, variant = "primary", size = "md", className = "", ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md" }) {
  const v = {
    primary: "bg-sky-600 text-white hover:bg-sky-700 disabled:bg-sky-400",
    secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
    danger: "bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-400",
    ghost: "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  }[variant];
  const s = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm";
  return <button {...p} className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${v} ${s} ${className}`}>{children}</button>;
}

export const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
      <button type="button" onClick={() => onChange(!checked)} className={`relative h-5 w-9 rounded-full transition ${checked ? "bg-sky-600" : "bg-slate-300 dark:bg-slate-700"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${checked ? "left-4.5" : "left-0.5"}`} />
      </button>
      {label}
    </label>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500"><Spinner /> {label}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-3xl">∅</div>
      <div className="font-medium text-slate-700 dark:text-slate-200">{title}</div>
      {children && <div className="max-w-md text-sm text-slate-500 dark:text-slate-400">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>;
}

export function Modal({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-16" onMouseDown={onClose}>
      <div className={`w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl bg-white shadow-xl dark:bg-slate-900`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ---------- toasts & confirm ----------
type Toast = { id: number; kind: "success" | "error" | "info"; msg: string };
type Confirm = { title: string; body: ReactNode; danger?: boolean; confirmLabel?: string; resolve: (v: boolean) => void };
const Ctx = createContext<{ toast: (kind: Toast["kind"], msg: string) => void; confirm: (o: Omit<Confirm, "resolve">) => Promise<boolean> } | null>(null);

export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conf, setConf] = useState<Confirm | null>(null);
  const toast = useCallback((kind: Toast["kind"], msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);
  const confirm = useCallback((o: Omit<Confirm, "resolve">) => new Promise<boolean>((resolve) => setConf({ ...o, resolve })), []);
  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-lg px-4 py-3 text-sm shadow-lg ${t.kind === "error" ? "bg-rose-600 text-white" : t.kind === "success" ? "bg-emerald-600 text-white" : "bg-slate-800 text-white"}`}>{t.msg}</div>
        ))}
      </div>
      <Modal open={!!conf} onClose={() => { conf?.resolve(false); setConf(null); }} title={conf?.title || ""}>
        <div className="text-sm text-slate-600 dark:text-slate-300">{conf?.body}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => { conf?.resolve(false); setConf(null); }}>Cancel</Button>
          <Button variant={conf?.danger ? "danger" : "primary"} onClick={() => { conf?.resolve(true); setConf(null); }}>{conf?.confirmLabel || "Confirm"}</Button>
        </div>
      </Modal>
    </Ctx.Provider>
  );
}

export function useUI() {
  const c = useContext(Ctx);
  if (!c) throw new Error("UIProvider missing");
  return c;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function Sparkline({ values, max = 100, height = 60, color = "#0284c7", threshold }: { values: number[]; max?: number; height?: number; color?: string; threshold?: number }) {
  const w = 300;
  if (values.length < 2) return <div style={{ height }} className="flex items-center justify-center text-xs text-slate-400">Collecting samples…</div>;
  const m = Math.max(max, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${height - (v / m) * height}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {threshold != null && <line x1="0" x2={w} y1={height - (threshold / m) * height} y2={height - (threshold / m) * height} stroke="#e11d48" strokeDasharray="4 3" strokeWidth="1" />}
      <polyline points={`0,${height} ${pts} ${w},${height}`} fill={color} fillOpacity="0.12" stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Bar({ value, tone }: { value: number | null; tone?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const c = tone || (v >= 90 ? "bg-rose-500" : v >= 70 ? "bg-amber-500" : "bg-emerald-500");
  return <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"><div className={`h-full ${c} transition-all`} style={{ width: `${v}%` }} /></div>;
}
