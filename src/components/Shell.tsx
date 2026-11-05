"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, UIProvider } from "./ui";

const NAV = [
  { href: "/", label: "Dashboard", icon: "◫" },
  { href: "/workers", label: "Proxy Workers", icon: "⇄" },
  { href: "/protection", label: "CPU Protection", icon: "⛨" },
  { href: "/monitoring", label: "Monitoring", icon: "∿" },
  { href: "/jobs", label: "Background Jobs", icon: "⚙" },
  { href: "/backups", label: "Backups", icon: "⛁" },
  { href: "/activity", label: "Audit Log", icon: "☰" },
  { href: "/settings", label: "Settings", icon: "✱" },
];

export default function Shell({ children, username }: { children: ReactNode; username: string }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggleTheme = () => {
    const d = !dark;
    setDark(d);
    document.documentElement.classList.toggle("dark", d);
    localStorage.setItem("mtp-theme", d ? "dark" : "light");
  };
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
  };
  return (
    <UIProvider>
      <div className="flex min-h-screen">
        <aside className={`fixed inset-y-0 left-0 z-40 w-60 transform border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-900 lg:static lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
          <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-5 dark:border-slate-800">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-600 font-bold text-white">M</div>
            <div>
              <div className="text-sm font-bold">MTPanel</div>
              <div className="text-[10px] text-slate-500">MTProto Proxy Manager</div>
            </div>
          </div>
          <nav className="space-y-0.5 p-3">
            {NAV.map((n) => {
              const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}`}>
                  <span className="w-4 text-center">{n.icon}</span>{n.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/80 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
            <button className="rounded p-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Menu">☰</button>
            <div className="hidden text-sm text-slate-500 lg:block">{NAV.find((n) => (n.href === "/" ? path === "/" : path.startsWith(n.href)))?.label}</div>
            <div className="flex items-center gap-2">
              <button onClick={toggleTheme} className="rounded-lg px-2.5 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800" title="Toggle theme">{dark ? "☀ Light" : "☾ Dark"}</button>
              <span className="text-sm text-slate-500">{username}</span>
              <button onClick={logout} className="rounded-lg px-2.5 py-1.5 text-sm text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30">Logout</button>
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 lg:p-6">{children}</main>
        </div>
      </div>
    </UIProvider>
  );
}
