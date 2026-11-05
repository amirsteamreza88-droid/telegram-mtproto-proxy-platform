import { test } from "node:test";
import assert from "node:assert/strict";
import { clientSecret, isValidDomain, isValidIPv4, isValidSecret, isValidSponsorTag, parseMtproxyStats, proxyLinks, toHex } from "../src/lib/core/mtproto.ts";

const S = "0123456789abcdef0123456789abcdef";

test("secret validation", () => {
  assert.ok(isValidSecret(S));
  assert.ok(!isValidSecret(S.toUpperCase()));
  assert.ok(!isValidSecret(S + "0"));
  assert.ok(!isValidSecret("dd" + S));
});

test("client secret formats per mode", () => {
  assert.equal(clientSecret("classic", S), S);
  assert.equal(clientSecret("secure", S), "dd" + S);
  assert.equal(clientSecret("faketls", S, "www.cloudflare.com"), "ee" + S + toHex("www.cloudflare.com"));
  assert.equal(toHex("ab"), "6162");
  assert.throws(() => clientSecret("faketls", S, null));
  assert.throws(() => clientSecret("classic", "xyz"));
});

test("links", () => {
  const l = proxyLinks("1.2.3.4", 443, "dd" + S);
  assert.equal(l.https, `https://t.me/proxy?server=1.2.3.4&port=443&secret=dd${S}`);
  assert.equal(l.tg, `tg://proxy?server=1.2.3.4&port=443&secret=dd${S}`);
});

test("domain / ip / tag validation rejects injection", () => {
  assert.ok(isValidDomain("example.com"));
  assert.ok(!isValidDomain("example.com; rm -rf /"));
  assert.ok(!isValidDomain("-bad.com"));
  assert.ok(!isValidDomain("localhost"));
  assert.ok(isValidIPv4("10.0.0.1"));
  assert.ok(!isValidIPv4("256.0.0.1"));
  assert.ok(!isValidIPv4("1.2.3.4 -j ACCEPT"));
  assert.ok(isValidSponsorTag("a".repeat(32)));
  assert.ok(!isValidSponsorTag("g".repeat(32)));
});

test("mtproxy stats parsing", () => {
  const s = parseMtproxyStats("total_special_connections\t12\ntotal_max_special_connections\t100\nbad line\n");
  assert.equal(s.total_special_connections, "12");
  assert.equal(s.total_max_special_connections, "100");
});
