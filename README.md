# MTPanel – Telegram MTProto Proxy Automation & Management Platform

MTPanel is a self-hosted platform that installs, deploys, monitors, protects and
maintains **official Telegram MTProxy** instances ("Workers") on a single Ubuntu
24.04 LTS VPS. You get a web dashboard. Each worker runs as its own systemd service
with its own port, secret, mode, bandwidth limits, connection limits, cgroup
accounting and sponsorship tag.

## Install (one command)

```bash
git clone https://github.com/YOUR_ORG/mtpanel.git && cd mtpanel && sudo bash install.sh
# with a domain + Let's Encrypt:
sudo bash install.sh --domain panel.example.com --email you@example.com
```

When it finishes, the installer prints the dashboard URLs (`https://<ip>:8443`,
`https://<domain>:8443`) and a **one-time administrator password**.

| Task | Command |
|------|---------|
| Update (automatic rollback on failure) | `sudo bash deploy/update.sh` |
| Full system backup (DB + config, AES-256) | `sudo bash deploy/backup.sh` |
| Restore system backup | `sudo bash deploy/restore.sh <file>` |
| Diagnostics | `sudo bash deploy/doctor.sh` |
| Reset admin password | `printf '%s' 'NewPassword123!' \| sudo -u mtpanel bash -c 'set -a; . /etc/mtpanel/panel.env; cd /opt/mtpanel/current && node scripts/create-admin.mjs --username admin --reset'` |
| Uninstall (keep data) / purge | `sudo bash deploy/uninstall.sh [--purge]` |

The installer is idempotent. Re-running it repairs the installation and keeps
existing secrets, passwords and certificates.

## What the installer does

1. Verifies Ubuntu 24.04, systemd and cgroup v2. Detects port conflicts (dashboard, backend, 80, 443).
2. Installs packages (PostgreSQL, nginx, UFW, build tools) and Node.js 22.
3. Creates two service accounts: `mtpanel` (runs the panel) and `mtproxy` (runs workers). Nothing runs as root except the validated helper.
4. Builds the official `TelegramMessenger/MTProxy` from source. It downloads `proxy-secret` / `proxy-multi.conf` and installs a daily refresh timer.
5. Configures PostgreSQL to listen on localhost only, with a random password.
6. Generates `APP_SECRET_KEY` (AES-256-GCM master key) in `/etc/mtpanel/panel.env`.
7. Builds a release in `/opt/mtpanel/releases/<ts>`, applies the schema and switches `/opt/mtpanel/current`.
8. Installs `/usr/local/sbin/mtpanel-helper` (root, 0755) plus a sudoers rule that allows only that file. It also installs the systemd units.
9. Sets up HTTPS on port 8443 via nginx:
   - **Domain:** a Let's Encrypt certificate via certbot, auto-renewed.
   - **IP:** a Let's Encrypt IP certificate (6-day *shortlived* profile, via acme.sh, renewed every 3 days) when issuance succeeds. Otherwise a **self-signed certificate**, which browsers will warn about. It is *not* publicly trusted.
10. Enables UFW: SSH, the dashboard port and 80 (ACME) are allowed. Worker ports are opened and closed automatically. The backend (3000) and PostgreSQL are never exposed.
11. Starts everything, verifies `/api/health` and HTTPS, creates the admin and prints the access addresses.

## Default ports

| Service | Port | Exposure |
|---|---|---|
| MTProto workers | 443 (first worker; any port per worker) | public |
| Dashboard (nginx TLS) | 8443 (`--panel-port`) | public |
| Backend (Next.js) | 3000 (`--backend-port`) | 127.0.0.1 only |
| PostgreSQL | 5432 | localhost only |
| MTProxy stats | 18001+ per worker | loopback only |

## Features

- **Workers:** create, start, stop, restart, edit, delete, view logs, copy the `t.me` / `tg://` link, copy the secret. Every action runs as a background job against the real systemd unit, with verification.
- **Deployment pipeline:** validate → resources → port check → secure random secret → config → systemd unit → start → process check → port probe → EPOLL check → public IP → link → save. A worker is marked `active` only after verification succeeds. Failed deployments are shown as `failed`, with logs.
- **Modes:**
  - Standard: `-S secret`.
  - Random padding: the client link uses the `dd` + secret prefix (padded packets); the server is started with the plain secret, exactly like classic — MTProxy has no server-side "dd-only" flag.
  - Fake-TLS: client `ee` + secret + hex(domain); server `-D domain`. The domain is validated with a DNS lookup and a TLS 1.3 handshake.
- **Connection management:** active TCP connections and unique source IPs are read from `/proc/net/tcp`. Connection attempts come from an iptables conntrack counter. The concurrent-connection limit is **enforced** with iptables `connlimit` and can be changed live.
- **Bandwidth:** separate download and upload limits per worker, using tc HTB on egress plus an ifb device on ingress. Filters match only that worker's port, so other workers, SSH and the panel are never affected. Limits change live.
- **Sponsorship:** three states, No sponsor → Waiting for tag → Sponsored. The panel guides you through @MTProxybot with the IP:port and secret. Tags are validated (32 hex), stored encrypted, applied with `-P` and verified after restart.
- **EPOLL:** MTProxy uses Linux epoll internally; it is not a configurable option, so the panel does not invent a setting. The panel checks that the kernel supports epoll and, at runtime, that the worker process holds `anon_inode:[eventpoll]` descriptors.
- **Monitoring:** total and per-core CPU, RAM, load, disk and network from `/proc`. Per-worker CPU and RAM come from cgroup v2 (`cpu.stat`, `memory.current`) of each systemd unit. Unmeasurable values are shown as "—", never estimated.
- **Automatic CPU protection:**
  - Samples every second. Triggers when CPU stays ≥ 90 % for 10 continuous seconds.
  - Stages: analysis → bandwidth reduction → per-IP connection limits (optional temporary IP blocks, off by default because of NAT) → emergency cgroup CPUQuota.
  - Recovers one stage at a time after 60 s below 80 %.
  - Configurable, persisted, deduplicated, and every action is logged. The panel, database and monitoring are never restricted.
- **Health:** checks systemd state and the port every 5 s and detects unexpected restarts. systemd restarts are bounded (5 per 5 min), and panel auto-restarts are bounded (default 5 per hour per worker), so restarts never loop endlessly.
- **Backups:**
  - In-app: encrypted (AES-256-GCM) configuration backups, scheduled or manual, with download, upload, validation (checksum + decrypt + structure) and restore (with an automatic safety backup and host re-sync).
  - System level: `deploy/backup.sh` / `restore.sh`.
  - Updates roll back automatically.
- **Security:**
  - scrypt password hashing, HTTP-only SameSite=strict session cookies, an Origin check on mutations, login rate limiting, and a full audit log.
  - Secrets and tags are encrypted at rest and redacted from logs.
  - A single root helper with strict argument and stdin validation; no shell interpolation anywhere.
  - Hardened worker units (`ProtectSystem=strict`, only `CAP_NET_BIND_SERVICE`).

## Development

```bash
cp .env.example .env        # point DATABASE_URL at a local PostgreSQL
npm install
npx drizzle-kit push
npm run dev                 # open http://localhost:3000/setup to create the first admin
bash scripts/test.sh        # unit tests + script syntax checks
```

Off the managed host (macOS, containers, CI), real system metrics still work wherever `/proc`
exists. Worker deployment fails with a clear "host agent unavailable" error. It is
never simulated.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data flow, privileges and **technical limitations**
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- [docs/TESTING.md](docs/TESTING.md): acceptance-test procedure for a real VPS
