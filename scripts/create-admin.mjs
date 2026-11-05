#!/usr/bin/env node
// Create or reset an administrator. Password is read from stdin (never from argv).
//   echo -n 'password' | node scripts/create-admin.mjs --username admin [--reset] [--if-none]
import crypto from "node:crypto";
import pg from "pg";

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const username = get("--username") || "admin";
const reset = args.includes("--reset");
const ifNone = args.includes("--if-none");
if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) { console.error("invalid username"); process.exit(2); }

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (password.length < 12) { console.error("password must be at least 12 characters"); process.exit(2); }

function hash(pw) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const h = crypto.scryptSync(pw, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${h.toString("base64")}`;
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  if (ifNone) {
    const r = await client.query("SELECT count(*)::int AS n FROM admins");
    if (r.rows[0].n > 0) { console.log("EXISTS"); process.exit(0); }
  }
  const ex = await client.query("SELECT id FROM admins WHERE username=$1", [username]);
  if (ex.rows[0]) {
    if (!reset) { console.error("user exists (use --reset)"); process.exit(3); }
    await client.query("UPDATE admins SET password_hash=$1 WHERE id=$2", [hash(password), ex.rows[0].id]);
    await client.query("DELETE FROM sessions WHERE admin_id=$1", [ex.rows[0].id]);
    console.log("RESET");
  } else {
    await client.query("INSERT INTO admins (username, password_hash) VALUES ($1,$2)", [username, hash(password)]);
    console.log("CREATED");
  }
  await client.query("INSERT INTO activity_logs (actor, action, target) VALUES ('cli','auth.admin_cli',$1)", [username]);
} finally {
  await client.end();
}
