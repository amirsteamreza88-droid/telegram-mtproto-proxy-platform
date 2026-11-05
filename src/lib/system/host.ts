import { execFile } from "node:child_process";
import fs from "node:fs";

// All privileged operations go through ONE root-owned helper script, invoked via
// `sudo -n` with a sudoers rule that allows exactly this binary for the panel user.
// Arguments are passed as argv (never through a shell) and are validated both here
// and again inside the helper, so command injection is not possible.

export const HELPER = process.env.HOST_HELPER || "/usr/local/sbin/mtpanel-helper";
export const SUDO = process.env.HOST_SUDO || "/usr/bin/sudo";

export class HostAgentError extends Error {}

export function run(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 30000, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } as unknown as NodeJS.ProcessEnv, encoding: "utf8" },
      (err: Error | null, stdout: string, stderr: string) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")), code });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

const SAFE_ARG = /^[A-Za-z0-9._:\-]{1,128}$/;

let availCache: { at: number; ok: boolean; reason: string } | null = null;

export async function hostAgentStatus(force = false): Promise<{ ok: boolean; reason: string }> {
  if (!force && availCache && Date.now() - availCache.at < 30000) return availCache;
  let res: { ok: boolean; reason: string };
  if (process.platform !== "linux") res = { ok: false, reason: "Not running on Linux" };
  else if (!fs.existsSync(HELPER)) res = { ok: false, reason: `Host helper ${HELPER} is not installed (run deploy/install.sh on Ubuntu 24.04)` };
  else {
    const r = await run(SUDO, ["-n", HELPER, "ping"], { timeoutMs: 5000 });
    res = r.code === 0 && r.stdout.includes("pong")
      ? { ok: true, reason: "ok" }
      : { ok: false, reason: `Host helper not callable via sudo: ${r.stderr.trim() || r.stdout.trim()}` };
  }
  availCache = { at: Date.now(), ...res };
  return res;
}

/** Run a helper action. Throws HostAgentError with stderr when the action fails. */
export async function helper(args: (string | number)[], input?: string, timeoutMs = 60000): Promise<string> {
  const sargs = args.map(String);
  for (const a of sargs) if (!SAFE_ARG.test(a)) throw new HostAgentError(`Rejected unsafe helper argument: ${JSON.stringify(a)}`);
  const st = await hostAgentStatus();
  if (!st.ok) throw new HostAgentError(st.reason);
  const r = await run(SUDO, ["-n", HELPER, ...sargs], { input, timeoutMs });
  if (r.code !== 0) {
    throw new HostAgentError(`helper ${sargs[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  }
  return r.stdout;
}

/** Unprivileged systemd status query. */
export async function unitStatus(id: number): Promise<{
  activeState: string;
  subState: string;
  mainPid: number;
  nRestarts: number;
  available: boolean;
}> {
  const r = await run("systemctl", ["show", `mtproxy@${id}.service`, "-p", "ActiveState,SubState,MainPID,NRestarts", "--no-pager"], { timeoutMs: 5000 });
  if (r.code !== 0) return { activeState: "unknown", subState: "unknown", mainPid: 0, nRestarts: 0, available: false };
  const kv: Record<string, string> = {};
  for (const l of r.stdout.split("\n")) {
    const i = l.indexOf("=");
    if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim();
  }
  return {
    activeState: kv.ActiveState || "unknown",
    subState: kv.SubState || "unknown",
    mainPid: Number(kv.MainPID || 0),
    nRestarts: Number(kv.NRestarts || 0),
    available: true,
  };
}
