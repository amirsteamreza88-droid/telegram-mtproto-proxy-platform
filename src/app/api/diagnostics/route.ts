import fs from "node:fs";
import { withAdmin } from "@/lib/auth";
import { ok } from "@/lib/api";
import { helper, hostAgentStatus, run } from "@/lib/system/host";
import { epollSupported, listeningPorts } from "@/lib/system/metrics";

export const GET = withAdmin(async () => {
  const agent = await hostAgentStatus(true);
  const checks: { name: string; ok: boolean | null; detail: string }[] = [];
  checks.push({ name: "Operating system", ok: process.platform === "linux", detail: fs.existsSync("/etc/os-release") ? (fs.readFileSync("/etc/os-release", "utf8").match(/PRETTY_NAME="([^"]+)"/)?.[1] ?? "linux") : process.platform });
  checks.push({ name: "Host agent (sudo helper)", ok: agent.ok, detail: agent.reason });
  checks.push({ name: "cgroup v2 accounting", ok: fs.existsSync("/sys/fs/cgroup/cgroup.controllers"), detail: fs.existsSync("/sys/fs/cgroup/cgroup.controllers") ? fs.readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8").trim() : "not mounted" });
  checks.push({ name: "Linux EPOLL", ok: epollSupported(), detail: epollSupported() ? "/proc/sys/fs/epoll present" : "not available" });
  const sc = await run("systemctl", ["--version"], { timeoutMs: 3000 });
  checks.push({ name: "systemd", ok: sc.code === 0, detail: sc.code === 0 ? sc.stdout.split("\n")[0] : "systemctl not available" });
  let doctor = "";
  if (agent.ok) {
    try { doctor = await helper(["doctor"]); } catch (e) { doctor = (e as Error).message; }
    for (const line of doctor.split("\n")) {
      const m = line.match(/^(OK|FAIL|WARN)\s+(.+?):\s*(.*)$/);
      if (m) checks.push({ name: m[2], ok: m[1] === "OK" ? true : m[1] === "FAIL" ? false : null, detail: m[3] });
    }
  }
  return ok({ checks, listeningPorts: [...listeningPorts()].sort((a, b) => a - b), node: process.version });
});
