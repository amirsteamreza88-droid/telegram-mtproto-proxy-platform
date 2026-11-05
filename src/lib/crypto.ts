import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let cachedKey: Buffer | null = null;

/**
 * 32-byte master key. Production: APP_SECRET_KEY (64 hex chars) from
 * /etc/mtpanel/panel.env (written by install.sh, mode 0640).
 * Dev fallback: a generated key persisted in DATA_DIR/secret.key (mode 0600).
 */
export function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.APP_SECRET_KEY;
  if (env && /^[0-9a-f]{64}$/i.test(env)) {
    cachedKey = Buffer.from(env, "hex");
    return cachedKey;
  }
  const dir = dataDir();
  const file = path.join(dir, "secret.key");
  if (fs.existsSync(file)) {
    cachedKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(file, cachedKey.toString("hex"), { mode: 0o600 });
  }
  return cachedKey;
}

export function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), ".data");
}

export function encrypt(plain: string, key: Buffer = masterKey()): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(payload: string, key: Buffer = masterKey()): string {
  const [v, ivb, tagb, encb] = payload.split(":");
  if (v !== "v1" || !ivb || !tagb || encb === undefined) throw new Error("Unsupported ciphertext format");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivb, "base64"));
  d.setAuthTag(Buffer.from(tagb, "base64"));
  return Buffer.concat([d.update(Buffer.from(encb, "base64")), d.final()]).toString("utf8");
}

export function encryptBuffer(plain: Buffer, key: Buffer = masterKey()): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from("MTPB1"), iv, c.getAuthTag(), enc]);
}

export function decryptBuffer(buf: Buffer, key: Buffer = masterKey()): Buffer {
  if (buf.subarray(0, 5).toString() !== "MTPB1") throw new Error("Not an MTPanel backup file");
  const iv = buf.subarray(5, 17);
  const tag = buf.subarray(17, 33);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(33)), d.final()]);
}

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function sha256(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// scrypt password hashing: scrypt$N$r$p$salt$hash
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = crypto.scryptSync(pw, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltb, hashb] = parts;
  const expected = Buffer.from(hashb, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(saltb, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(expected, got);
}
