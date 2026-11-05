// Pure parser for the host helper's NETSTATUS output line. No dependencies.

export interface NetStatus {
  at: string;
  exitCode: number | null;
  error?: string;
  components: Record<string, string>; // tc_v4, tc_v6, ifb_v4, ifb_v6, nft_global, ip4_fw, ip6_fw
  enforced: boolean; // true only if every applicable component reported ok/off
  partial: boolean;
}

export function parseNetStatus(stdout: string, exitCode: number | null, stderr: string): NetStatus {
  const components: Record<string, string> = {};
  const line = stdout.split("\n").find((l) => l.startsWith("NETSTATUS ")) || "";
  for (const part of line.replace(/^NETSTATUS /, "").split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0) components[part.slice(0, i)] = part.slice(i + 1);
  }
  const applicable = Object.entries(components).filter(([k]) => !["id", "port"].includes(k));
  const failed = applicable.filter(([, v]) => v !== "ok" && v !== "off");
  return {
    at: new Date().toISOString(),
    exitCode,
    ...(stderr.trim() ? { error: stderr.trim().slice(0, 500) } : {}),
    components,
    enforced: applicable.length > 0 && failed.length === 0,
    partial: failed.length > 0 && failed.length < applicable.length,
  };
}

