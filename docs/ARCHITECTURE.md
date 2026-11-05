# Architecture

```
                 Internet
   ┌───────────────┼──────────────────────────────┐
   │ :443…  MTProto workers          :8443 nginx (TLS)
   │   mtproxy@1.service ─┐              │
   │   mtproxy@2.service ─┤ tc/ifb +     ▼
   │   …   (user mtproxy) │ iptables   127.0.0.1:3000  Next.js (user mtpanel)
   │                      │ per port     ├─ App Router UI (React)
   │   cgroup v2 slice    │              ├─ REST API (/api/*)  ── auth, audit
   │   system-mtproxy     │              ├─ Job runner (DB-backed queue)
   │                      │              ├─ Monitor (1s /proc, 5s tc/iptables/cgroup)
   │                      │              ├─ CPU protection engine (1s)
   │                      │              ├─ Health monitor (5s) + scheduler
   │                      │              └─ sudo -n mtpanel-helper <action>  (root, validated)
   │                      │                                   │
   │   PostgreSQL (localhost) ◄── Drizzle ORM                 ▼
   │                                    systemctl · tc · iptables · journalctl · ufw
   └──────────────────────────────────────────────────────────────────────────────┘
```

## Deviation from the original specification

The specification named React + Vite, Express and Prisma. This repository uses the
same layers in an integrated form:

- **Next.js (App Router):** the React UI and the Node.js API in one process.
- **Drizzle ORM:** used with PostgreSQL instead of Prisma.

Schema changes are applied with `drizzle-kit push` (no migration files). Before each
push, update.sh takes a database snapshot and rolls back automatically if the push
fails.

## Components

| Component | Location |
|---|---|
| Database schema (all models) | `src/db/schema.ts` |
| Worker lifecycle / deployment / rollback | `src/lib/workers.ts` |
| Background jobs | `src/lib/jobs.ts` |
| Monitoring | `src/lib/monitor.ts`, `src/lib/system/metrics.ts` |
| CPU protection state machine (pure, unit-tested) | `src/lib/core/protection-engine.ts` |
| CPU protection executor | `src/lib/protection.ts` |
| Health monitor, loops, scheduler | `src/lib/runtime.ts` (started from `src/instrumentation.ts`) |
| Backups | `src/lib/backup.ts` |
| Privileged helper | `deploy/mtpanel-helper` |
| Worker launcher | `deploy/run-worker.sh` |
| Installer & ops scripts | `install.sh`, `deploy/*.sh` |

## Privilege model

- The panel runs as `mtpanel`. Its only privilege is `sudo -n /usr/local/sbin/mtpanel-helper`.
- The helper accepts a fixed set of actions. Every argument is checked against strict regexes, both in Node and again in bash. Configuration is passed on stdin as `KEY=value`, validated per key, and never evaluated.
- Workers run as `mtproxy`, with only `CAP_NET_BIND_SERVICE`, `ProtectSystem=strict` and private /tmp.
- Worker configs live in `/etc/mtpanel/workers/<id>.env` (root, 0600). The previous version is kept as `.env.prev`.

## Persistence across reboots

- Worker units are `enable`d.
- `mtpanel-netrules.service` restores the tc and iptables rules from `/var/lib/mtpanel/net/*.net` before the panel starts.
- Protection stage and active restrictions are stored in PostgreSQL. After a restart, the stage is kept and the timers start fresh.
- Queued jobs survive restarts. Jobs that were running are requeued if they have attempts left, otherwise they are marked failed.

## Technical limitations (read this)

1. **Only a real Telegram client can verify end-to-end connectivity.** The panel verifies the systemd state, the TCP listener, the stats endpoint, epoll usage and (for Fake-TLS) the domain's TLS 1.3. Test each mode with a real Telegram client (see TESTING.md).
2. **Unique IPs ≠ unique users.** Carrier-grade NAT and shared networks put many people behind one IP. For this reason, IP blocking during protection is disabled by default, and when enabled it applies only to IPs with ≥ 400 concurrent connections (configurable).
3. **The connection limit applies to TCP connections, not users.** One Telegram client opens several connections. The global limit is enforced with a single nftables rule in `family inet` (`ct count over N`), so IPv4 and IPv6 share ONE counter per worker. On kernels without `ct count` the helper falls back to per-family iptables `connlimit --connlimit-mask 0`. That fallback is NOT a shared counter — combined IPv4+IPv6 connections can then exceed TOTAL — so it is reported as `nft_global=fallback-iptables-per-family`, counted as partial failure (exit 3), and never displayed as enforced. Existing connections stay; only new SYNs above the limit are rejected.
4. **Every network component reports its real status.** The helper prints a `NETSTATUS` line (`tc_v4`, `tc_v6`, `ifb_v4`, `ifb_v6`, `nft_global`, `ip4_fw`, `ip6_fw`) and exits 0 only when everything applied, 3 on partial failure, 1 when nothing applied. The panel stores it per worker (`workers.net_status`) and the dashboard shows `enforced / partial / failed` — a failed component is never shown as enforced. Bandwidth limits apply to client-side traffic (worker port ↔ client). Traffic between the proxy and Telegram DCs uses ephemeral ports and is not shaped. Shaping the client side throttles both directions in practice.
5. **The traffic counters come from tc class counters.** The panel accumulates deltas in the database. Counters reset when the interface is reset, which is handled as a counter reset.
6. **kernel.pid_max:** the official MTProxy asserts on PIDs > 65535, and Ubuntu 24.04 defaults to 4194304. The installer therefore sets `kernel.pid_max=65535` (opt out with `--keep-pid-max`).
7. **Secrets on the command line:** MTProxy takes the secret as `-S`, which is visible in `/proc/<pid>/cmdline` to local users. Do not give untrusted users shell access to the VPS. Mounting `/proc` with `hidepid=2` mitigates this.
8. **Sponsorship status:** @MTProxybot does not provide an API. "Sponsored" means a valid tag issued by the bot was applied and the worker was verified running with it. Promotion statistics are visible only in the bot.
9. **Backups are encrypted with `APP_SECRET_KEY`.** Store that key outside the server; without it, in-app backups cannot be restored on a new host.
10. **Single-process background services.** Monitoring, protection and jobs run inside the panel process (systemd `Restart=always`, `CPUWeight=1000`, `Nice=-5`). If the panel process is down, protection is paused, but restrictions already applied stay in effect.
