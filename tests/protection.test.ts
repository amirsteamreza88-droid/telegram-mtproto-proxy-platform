// CPU protection state machine tested with SIMULATED metrics (1 sample per second).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROTECTION_CONFIG as C, evaluate, INITIAL_STATE, pickTopConsumers, reducedLimit, validateConfig, type Decision, type ProtectionStateData } from "../src/lib/core/protection-engine.ts";

function simulate(samples: number[], cfg = C, start: ProtectionStateData = INITIAL_STATE) {
  let s = { ...start };
  const decisions: { t: number; d: Decision }[] = [];
  samples.forEach((cpu, i) => {
    const r = evaluate(s, cpu, 1_000_000 + i * 1000, cfg);
    s = r.state;
    if (r.decision.kind !== "none") decisions.push({ t: i, d: r.decision });
  });
  return { s, decisions };
}
const rep = (v: number, n: number) => Array(n).fill(v);

test("short spikes never trigger", () => {
  const { s, decisions } = simulate([...rep(95, 9), 50, ...rep(99, 9), 89, ...rep(100, 5)]);
  assert.equal(decisions.length, 0);
  assert.equal(s.stage, 0);
});

test("triggers after >= 10 continuous seconds at >= 90%", () => {
  const { decisions } = simulate(rep(90, 12));
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].d, { kind: "escalate", from: 0, to: 2 });
  assert.equal(decisions[0].t, 10); // 11th sample = 10s after first
});

test("escalates gradually up to maxStage, never beyond, no duplicates", () => {
  const { s, decisions } = simulate(rep(100, 120));
  assert.deepEqual(decisions.map((d) => (d.d as { to: number }).to), [2, 3, 4]);
  assert.equal(s.stage, 4);
  const limited = simulate(rep(100, 120), { ...C, maxStage: 3 });
  assert.equal(limited.s.stage, 3);
});

test("recovery requires CPU < 80% for 60s and restores one stage per period", () => {
  const over = simulate(rep(100, 60));
  assert.equal(over.s.stage, 4);
  // 85% is below trigger but above recovery: no recovery
  const mid = simulate(rep(85, 200), C, over.s);
  assert.equal(mid.decisions.length, 0);
  const rec = simulate(rep(30, 260), C, over.s);
  assert.deepEqual(rec.decisions.map((d) => [d.d.kind, (d.d as { to: number }).to]), [["recover", 3], ["recover", 2], ["recover", 0]]);
  assert.equal(rec.decisions[0].t, 60);
  assert.equal(rec.decisions[1].t, 120);
  assert.equal(rec.s.stage, 0);
});

test("a CPU bump during recovery resets the recovery timer", () => {
  const over = simulate(rep(100, 20));
  const r = simulate([...rep(30, 50), 82, ...rep(30, 59)], C, over.s);
  assert.equal(r.decisions.length, 0);
});

test("disabling restores everything", () => {
  const over = simulate(rep(100, 30));
  const r = evaluate(over.s, 100, 2_000_000, { ...C, enabled: false });
  assert.equal(r.decision.kind, "restore_all");
  assert.equal(r.state.stage, 0);
});

test("state survives restart (persisted stage continues)", () => {
  const over = simulate(rep(100, 30));
  const restored = { ...over.s, aboveSince: null, belowSince: null };
  const r = simulate(rep(20, 61), C, restored);
  assert.equal(r.decisions[0]?.d.kind, "recover");
});

test("config validation", () => {
  assert.equal(validateConfig(C), null);
  assert.ok(validateConfig({ ...C, recoveryPercent: 95 }));
  assert.ok(validateConfig({ ...C, triggerSeconds: 1 }));
  assert.ok(validateConfig({ ...C, stage3IpBlockThreshold: 5 }));
});

test("top consumers skip unmeasured workers", () => {
  const top = pickTopConsumers([{ id: 1, cpuPercent: null }, { id: 2, cpuPercent: 30 }, { id: 3, cpuPercent: 50 }, { id: 4, cpuPercent: 0 }], 2);
  assert.deepEqual(top.map((t) => t.id), [3, 2]);
});

test("reduced limits", () => {
  assert.equal(reducedLimit(10000, 0, 0.5, 1024), 5000);
  assert.equal(reducedLimit(null, 8000, 0.5, 1024), 4000);
  assert.equal(reducedLimit(null, 0, 0.5, 1024), 1024);
});
