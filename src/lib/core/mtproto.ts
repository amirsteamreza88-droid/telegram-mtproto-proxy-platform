// Pure helpers for MTProto proxy secrets, links and input validation.
// No imports so this module can be unit-tested directly with node --test.

export type ProxyMode = "classic" | "secure" | "faketls";
export const PROXY_MODES: ProxyMode[] = ["classic", "secure", "faketls"];

export const MODE_LABELS: Record<ProxyMode, string> = {
  classic: "Standard MTProto",
  secure: "Secure (random padding, dd)",
  faketls: "Fake-TLS (ee)",
};

const HEX32 = /^[0-9a-f]{32}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function isValidSecret(s: string): boolean {
  return HEX32.test(s);
}

/** Sponsorship tags issued by @MTProxyBot are 32 lowercase hex chars. */
export function isValidSponsorTag(s: string): boolean {
  return HEX32.test(s);
}

export function normalizeTag(s: string): string {
  return s.trim().toLowerCase();
}

export function isValidDomain(d: string): boolean {
  return DOMAIN_RE.test(d.toLowerCase());
}

export function isValidPort(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

export function isValidWorkerName(n: string): boolean {
  return /^[\p{L}\p{N} _.-]{1,64}$/u.test(n);
}

export function isValidIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function toHex(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) out += str.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

/**
 * Secret as presented to the Telegram client.
 *  classic : <secret>
 *  secure  : dd<secret>           (client uses random padding)
 *  faketls : ee<secret><hex(domain)>
 * The server is always started with the raw 16-byte secret (-S <secret>);
 * secure mode additionally passes -R and fake-TLS passes -D <domain>.
 */
export function clientSecret(mode: ProxyMode, secret: string, domain?: string | null): string {
  if (!isValidSecret(secret)) throw new Error("invalid secret");
  if (mode === "secure") return "dd" + secret;
  if (mode === "faketls") {
    if (!domain || !isValidDomain(domain)) throw new Error("fake-TLS requires a valid domain");
    return "ee" + secret + toHex(domain.toLowerCase());
  }
  return secret;
}

export function proxyLinks(host: string, port: number, csecret: string) {
  const q = `server=${encodeURIComponent(host)}&port=${port}&secret=${csecret}`;
  return { tg: `tg://proxy?${q}`, https: `https://t.me/proxy?${q}` };
}

/** Parse the plain-text output of MTProxy's local /stats endpoint. */
export function parseMtproxyStats(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("\t");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}
