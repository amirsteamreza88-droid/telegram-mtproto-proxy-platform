import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNetStatus } from "../src/lib/core/netstatus.ts";

test("full success parses as enforced", () => {
  const ns = parseNetStatus("NETSTATUS id=1 port=443 tc_v4=ok tc_v6=ok ifb_v4=ok ifb_v6=ok nft_global=ok ip4_fw=ok ip6_fw=ok\n", 0, "");
  assert.equal(ns.enforced, true);
  assert.equal(ns.partial, false);
  assert.equal(ns.components.nft_global, "ok");
});

test("nft failure with working tc is partial, not enforced", () => {
  const ns = parseNetStatus("NETSTATUS id=1 port=443 tc_v4=ok tc_v6=ok ifb_v4=ok ifb_v6=ok nft_global=failed ip4_fw=skipped ip6_fw=skipped\n", 1, "boom");
  assert.equal(ns.enforced, false);
  assert.equal(ns.partial, true);
  assert.equal(ns.exitCode, 1);
  assert.equal(ns.error, "boom");
});

test("fallback label is not treated as enforced", () => {
  const ns = parseNetStatus("NETSTATUS id=1 port=443 tc_v4=ok nft_global=fallback-iptables-per-family ip4_fw=ok ip6_fw=ok\n", 3, "");
  assert.equal(ns.enforced, false);
  assert.equal(ns.partial, true);
});

test("ipv6-only failure is distinguishable from ipv4", () => {
  const ns = parseNetStatus("NETSTATUS id=1 port=443 tc_v4=ok tc_v6=failed ifb_v4=ok ifb_v6=failed nft_global=off ip4_fw=ok ip6_fw=ok\n", 3, "");
  assert.equal(ns.components.tc_v4, "ok");
  assert.equal(ns.components.tc_v6, "failed");
  assert.equal(ns.enforced, false);
});

test("empty/garbage output is not enforced", () => {
  const ns = parseNetStatus("some other output\n", null, "helper missing");
  assert.equal(ns.enforced, false);
  assert.equal(ns.partial, false);
  assert.deepEqual(ns.components, {});
});
