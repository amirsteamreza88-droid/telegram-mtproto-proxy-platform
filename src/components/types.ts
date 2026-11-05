export type WorkerDTO = {
  id: number; name: string; port: number; statsPort: number; mode: string; tlsDomain: string | null;
  status: string; statusMessage: string | null; desiredState: string; secretMasked: string;
  maxConnections: number | null; connLimitEnabled: boolean; downloadKbps: number | null; uploadKbps: number | null; bwLimitEnabled: boolean;
  autoRestart: boolean; restartCount: number; epollStatus: string; publicIp: string | null;
  trafficRxBytes: number; trafficTxBytes: number; configVersion: number; lastVerifiedAt: string | null; createdAt: string;
  sponsorState: string; sponsorRequestedAt: string | null; sponsorActivatedAt: string | null; sponsorVerifiedAt: string | null;
  netStatus: { at: string; exitCode: number | null; error?: string; components: Record<string, string>; enforced: boolean; partial: boolean } | null;
  restrictions: { id: number; kind: string; stage: number; value: Record<string, number>; target: string | null; reason: string | null; expiresAt: string | null }[];
  live: {
    cpuPercent: number | null; cpuCorePercent: number | null; memBytes: number | null; connections: number | null; uniqueIps: number | null;
    attempts: number | null; rxRate: number | null; txRate: number | null; topIps: { ip: string; count: number }[];
  } | null;
};

export const MODE_LABEL: Record<string, string> = { classic: "Standard", secure: "Random padding (dd, client-side)", faketls: "Fake-TLS (ee)" };
export const SPONSOR_LABEL: Record<string, { label: string; color: string }> = {
  none: { label: "No sponsor", color: "gray" },
  waiting: { label: "Waiting for tag", color: "amber" },
  active: { label: "Sponsored", color: "violet" },
};
