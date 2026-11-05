// Pure CPU-protection state machine. No I/O; the protection service feeds it
// one CPU sample per ~1s tick and executes the returned decision.
//
// Stages:
//  0 normal
//  1 analysis (transient – recorded when the trigger fires)
//  2 speed reduction on top-consuming workers
//  3 connection restrictions (per-IP connlimit, optional temporary IP blocks)
//  4 emergency (cgroup CPUQuota + stronger bandwidth cap on top workers)

export interface ProtectionConfig {
  enabled: boolean;
  triggerPercent: number; // default 90
  triggerSeconds: number; // default 10
  recoveryPercent: number; // default 80
  recoverySeconds: number; // default 60
  escalateSeconds: number; // time between escalations while still overloaded
  maxStage: number; // 2..4
  topWorkers: number;
  stage2BandwidthFactor: number; // 0..1 of current limit / measured rate
  stage2MinKbps: number;
  stage3PerIpConnLimit: number;
  stage3IpBlockEnabled: boolean;
  stage3IpBlockThreshold: number; // concurrent connections from a single IP
  stage3IpBlockMinutes: number;
  stage4BandwidthFactor: number;
  stage4CpuQuotaPercent: number; // systemd CPUQuota= (100 = one core)
}

export const DEFAULT_PROTECTION_CONFIG: ProtectionConfig = {
  enabled: true,
  triggerPercent: 90,
  triggerSeconds: 10,
  recoveryPercent: 80,
  recoverySeconds: 60,
  escalateSeconds: 20,
  maxStage: 4,
  topWorkers: 2,
  stage2BandwidthFactor: 0.5,
  stage2MinKbps: 1024,
  stage3PerIpConnLimit: 64,
  stage3IpBlockEnabled: false,
  stage3IpBlockThreshold: 400,
  stage3IpBlockMinutes: 10,
  stage4BandwidthFactor: 0.25,
  stage4CpuQuotaPercent: 50,
};

export interface ProtectionStateData {
  stage: number;
  aboveSince: number | null;
  belowSince: number | null;
  lastEscalationAt: number | null;
  lastRecoveryAt: number | null;
}

export const INITIAL_STATE: ProtectionStateData = {
  stage: 0,
  aboveSince: null,
  belowSince: null,
  lastEscalationAt: null,
  lastRecoveryAt: null,
};

export type Decision =
  | { kind: "none" }
  | { kind: "escalate"; from: number; to: number }
  | { kind: "recover"; from: number; to: number }
  | { kind: "restore_all"; from: number };

export function validateConfig(c: ProtectionConfig): string | null {
  if (c.triggerPercent <= 0 || c.triggerPercent > 100) return "triggerPercent must be 1..100";
  if (c.recoveryPercent <= 0 || c.recoveryPercent >= c.triggerPercent)
    return "recoveryPercent must be below triggerPercent";
  if (c.triggerSeconds < 3) return "triggerSeconds must be >= 3 (short spikes must not trigger)";
  if (c.recoverySeconds < 5) return "recoverySeconds must be >= 5";
  if (c.escalateSeconds < 5) return "escalateSeconds must be >= 5";
  if (c.maxStage < 2 || c.maxStage > 4) return "maxStage must be 2..4";
  if (c.topWorkers < 1) return "topWorkers must be >= 1";
  if (c.stage2BandwidthFactor <= 0 || c.stage2BandwidthFactor >= 1) return "stage2BandwidthFactor must be in (0,1)";
  if (c.stage4BandwidthFactor <= 0 || c.stage4BandwidthFactor >= 1) return "stage4BandwidthFactor must be in (0,1)";
  if (c.stage3PerIpConnLimit < 4) return "stage3PerIpConnLimit must be >= 4";
  if (c.stage3IpBlockThreshold < 50) return "stage3IpBlockThreshold must be >= 50 (NAT safety)";
  if (c.stage4CpuQuotaPercent < 5) return "stage4CpuQuotaPercent must be >= 5";
  return null;
}

/**
 * Advance the state machine by one sample.
 * cpu: global CPU usage percent (0..100) measured over the last interval.
 * now: epoch ms.
 */
export function evaluate(
  prev: ProtectionStateData,
  cpu: number,
  now: number,
  cfg: ProtectionConfig,
): { state: ProtectionStateData; decision: Decision } {
  const s: ProtectionStateData = { ...prev };

  if (!cfg.enabled) {
    const decision: Decision = s.stage > 0 ? { kind: "restore_all", from: s.stage } : { kind: "none" };
    return { state: { ...INITIAL_STATE }, decision };
  }

  // Continuous-duration tracking. Any dip below the trigger resets the timer.
  if (cpu >= cfg.triggerPercent) s.aboveSince = s.aboveSince ?? now;
  else s.aboveSince = null;
  if (cpu < cfg.recoveryPercent) s.belowSince = s.belowSince ?? now;
  else s.belowSince = null;

  const aboveMs = s.aboveSince != null ? now - s.aboveSince : 0;
  const belowMs = s.belowSince != null ? now - s.belowSince : 0;

  if (s.stage === 0) {
    if (aboveMs >= cfg.triggerSeconds * 1000) {
      s.stage = 2;
      s.lastEscalationAt = now;
      s.lastRecoveryAt = null;
      return { state: s, decision: { kind: "escalate", from: 0, to: 2 } };
    }
    return { state: s, decision: { kind: "none" } };
  }

  // Already protecting: escalate while overload persists.
  if (
    s.stage < cfg.maxStage &&
    aboveMs >= cfg.triggerSeconds * 1000 &&
    s.lastEscalationAt != null &&
    now - s.lastEscalationAt >= cfg.escalateSeconds * 1000
  ) {
    const from = s.stage;
    s.stage = from + 1;
    s.lastEscalationAt = now;
    return { state: s, decision: { kind: "escalate", from, to: s.stage } };
  }

  // Gradual recovery: one stage per recoverySeconds of sustained low CPU.
  if (belowMs >= cfg.recoverySeconds * 1000) {
    const sinceLast = s.lastRecoveryAt != null ? now - s.lastRecoveryAt : Infinity;
    if (sinceLast >= cfg.recoverySeconds * 1000) {
      const from = s.stage;
      const to = from <= 2 ? 0 : from - 1;
      s.stage = to;
      s.lastRecoveryAt = now;
      if (to === 0) {
        s.lastEscalationAt = null;
      }
      return { state: s, decision: { kind: "recover", from, to } };
    }
  }

  return { state: s, decision: { kind: "none" } };
}

/** Pick the highest consuming workers by measured CPU. Unmeasured workers are skipped. */
export function pickTopConsumers<T extends { id: number; cpuPercent: number | null }>(list: T[], n: number): T[] {
  return list
    .filter((w) => w.cpuPercent != null && w.cpuPercent > 0)
    .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
    .slice(0, n);
}

/** Compute a reduced kbit/s limit from the current limit (or measured rate when unlimited). */
export function reducedLimit(currentKbps: number | null, measuredKbps: number, factor: number, minKbps: number): number {
  const base = currentKbps && currentKbps > 0 ? currentKbps : Math.max(measuredKbps, minKbps * 2);
  return Math.max(minKbps, Math.floor(base * factor));
}
