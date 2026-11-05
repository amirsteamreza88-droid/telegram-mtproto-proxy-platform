// CPUQuota recovery tests: DB rows must be deactivated ONLY after the host helper
// confirms (via the cpuquota-check action) that systemd no longer has a quota.
// Uses the real database and a fake host helper whose failure is controlled by a file.
import { test, before, after } from "node:test";
import { eq, sql } from "drizzle-orm";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// env must be set before importing modules that read it at load time
const envText = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const T = fs.mkdtempSync(path.join(os.tmpdir(), "mtp-cpuquota-"));
const FAKE = path.join(T, "fake-helper");
fs.writeFileSync(FAKE, `#!/bin/bash
# fake host helper for tests
case "$1" in
  ping) echo pong; exit 0 ;;
  cpuquota)
    # cpuquota <id> off
    if [[ -f "${T}/FAIL" ]]; then echo "simulated systemctl failure" >&2; exit 1; fi
    echo off > "${T}/quota-$2"; echo ok; exit 0 ;;
  cpuquota-check)
    if [[ -f "${T}/FAIL" ]]; then echo "50%"; exit 0; fi   # systemd still reports a quota
    if [[ -f "${T}/quota-$2" ]]; then echo off; else echo "50%"; fi; exit 0 ;;
  net-apply)
    cat > /dev/null
    echo "NETSTATUS id=1 port=1 tc_v4=ok tc_v6=ok ifb_v4=ok ifb_v6=ok nft_global=ok ip4_fw=ok ip6_fw=ok"
    exit 0 ;;
  *) echo ok; exit 0 ;;
esac
`, { mode: 0o755 });
process.env.HOST_HELPER = FAKE;

let mod: typeof import("../src/lib/protection.ts");
let dbMod: typeof import("../src/db/index.ts");
let schema: typeof import("../src/db/schema.ts");
let workerId = 0;

before(async () => {
  mod = await import("../src/lib/protection.ts");
  dbMod = await import("../src/db/index.ts");
  schema = await import("../src/db/schema.ts");
  const { workers, restrictions } = schema;
  const { db } = dbMod;
  await db.delete(workers).where(eq(workers.name, "cpuquota-test"));
  const [w] = await db.insert(workers).values({ name: "cpuquota-test", port: 29999, statsPort: 29998, mode: "classic", status: "active" }).returning();
  workerId = w.id;
  await db.insert(restrictions).values({ workerId, kind: "cpu_quota", stage: 4, value: { percent: 50 }, active: true, reason: "test" });
});

after(async () => {
  const { workers, restrictions, protectionEvents } = schema;
  const { db } = dbMod;
  await db.delete(restrictions).where(eq(restrictions.workerId, workerId));
  await db.delete(protectionEvents);
  await db.delete(workers).where(eq(workers.id, workerId));
  fs.rmSync(T, { recursive: true, force: true });
});

async function restrictionActive() {
  const { restrictions } = schema;
  const rows = await dbMod.db.select().from(restrictions).where(eq(restrictions.workerId, workerId));
  return rows;
}

test("successful CPUQuota removal: helper confirms -> DB row deactivated", async () => {
  fs.rmSync(path.join(T, "FAIL"), { force: true });
  const lifted = await mod.liftWhere(sql`true`);
  assert.equal(lifted, 1);
  const rows = await restrictionActive();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].active, false, "restriction must be inactive after confirmed removal");
  assert.ok(rows[0].liftedAt);
  assert.ok(fs.existsSync(path.join(T, `quota-${workerId}`)), "helper was asked to remove the quota");
});

test("failed CPUQuota removal: DB row stays active, error event recorded, retry works", async () => {
  const { restrictions, protectionEvents } = schema;
  const { db } = dbMod;
  // re-activate the restriction and simulate a failing helper
  await db.update(restrictions).set({ active: true, liftedAt: null }).where(eq(restrictions.workerId, workerId));
  fs.writeFileSync(path.join(T, "FAIL"), "1");
  const lifted = await mod.liftWhere(sql`true`);
  assert.equal(lifted, 0, "nothing may be reported as lifted when removal fails");
  let rows = await restrictionActive();
  assert.equal(rows[0].active, true, "restriction must STAY active when systemd still has the quota");
  const evs = await db.select().from(protectionEvents);
  assert.ok(evs.some((e) => e.type === "error" && e.message.includes("CPUQuota")), "an error event must be recorded");
  // retry after the failure is fixed
  fs.rmSync(path.join(T, "FAIL"), { force: true });
  const lifted2 = await mod.liftWhere(sql`true`);
  assert.equal(lifted2, 1, "retry after failure must succeed");
  rows = await restrictionActive();
  assert.equal(rows[0].active, false, "after successful retry the row is deactivated");
});
