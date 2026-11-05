# Testing & acceptance

## Automated (any machine)

`bash scripts/test.sh` runs (skips are reported as SKIP, never counted as passed):

- Unit tests for secret formats, link generation and input validation (including injection attempts).
- Unit tests for the CPU-protection state machine with **simulated metrics**: spike immunity, the 10 s trigger, staged escalation, the maxStage cap, 60 s recovery steps, timer reset, disable → restore, and continuity after a restart.
- `tests/helper-net.test.sh` — command-generation and failure-handling tests of the host helper with mocked `nft`/`tc`/`iptables`: full success, nftables failure (fallback engaged and labeled, tc preserved), IPv6-only tc failure (v4/v6 reported independently), ifb unavailability (upload NOT claimed enforced), TOTAL=0, rule dedup on reapply, per-worker independent counters, cleanup on remove, injection rejection.
- `tests/netns-integration.sh` — the same paths against REAL `nft`/`tc`/`iptables` inside an isolated `unshare -rn` network namespace. Skipped (exit 3) where namespaces are unavailable. On kernels with tc/ifb/connlimit/`ct count` (Ubuntu 24.04, 6.8) the full enforcement assertions run; on limited kernels the honest-failure assertions run.
- `bash -n` syntax checks of all deploy scripts, plus shellcheck if installed.

Per-worker layered checks on the VPS: `sudo bash scripts/test-mtproxy.sh <id>` prints process, TCP port, stats endpoint, protocol probe, EPOLL usage — and always marks real Telegram client connectivity as **NOT VERIFIED** until you actually connect with Telegram.

## Manual acceptance on a dedicated Ubuntu 24.04 test VPS

Do **not** run load tests on production infrastructure.

| # | Test | Expected |
|---|---|---|
| 1 | Fresh `sudo bash install.sh` | Prints URLs and admin password. `deploy/doctor.sh` shows no FAIL. |
| 2 | Log in; wrong password 11× | Login works. The rate limit triggers (HTTP 429). Both appear in the audit log. |
| 3 | Create a Standard worker on 443 | Job succeeds; status `active`; `systemctl status mtproxy@1` is active; the t.me link connects in Telegram. |
| 4 | Create Random-padding (dd) worker on 8444 | Connects with the `dd` link. The plain-secret link is refused (server (no -R flag exists)). |
| 5 | Create Fake-TLS worker on 8445 | The domain check passes; the `ee` link connects in Telegram. |
| 6 | Multiple workers | Independent ports, secrets, units, cgroups and counters. |
| 7 | Sponsorship | "Register" shows IP:port and secret → do `/newproxy` in @MTProxybot → paste the tag → job restarts the worker → `Sponsored`, verified. The journal shows `-P` in use; the bot shows the proxy. |
| 8 | No sponsor | Remove the sponsorship → the worker restarts without a tag. |
| 9 | Bandwidth | Set ↓ 2000 kbit/s → a download through the proxy stays at ≈ 2 Mbit/s; other workers are unaffected (`tc -s class show`). |
| 10 | Connection limit | Set the limit to 5 → open more connections (e.g. `for i in $(seq 10); do nc -w30 IP PORT & done`) → after 5, connections are reset; `iptables -S MTPW<id>` shows the connlimit rule. |
| 11 | CPU accounting | Load a worker with traffic → the CPU column matches `systemd-cgtop`. |
| 12 | EPOLL | The worker shows `active (n eventpoll fd)`; it matches `ls -l /proc/$(systemctl show -p MainPID --value mtproxy@1)/fd \| grep eventpoll`. |
| 12b | Network rules | After creating a worker with limits, the worker page shows `enforced` and `nft list chain inet mtpanel input` shows one `ct count over` rule per worker. `sudo bash tests/netns-integration.sh` passes with tc/connlimit enabled. |
| 13 | CPU protection (test VPS!) | Set trigger 50 %, 5 s. Run `stress-ng --cpu $(nproc) --timeout 120s`. Expected: events show trigger → stage 2/3/4, restrictions are listed, and after stress stops recovery happens step by step and the restrictions are lifted. No worker restrictions apply if the load comes from stress-ng itself (the event says so). For worker-caused load, generate proxy traffic. |
| 14 | Health | `kill -9` the worker main PID → systemd restarts it and the panel logs `worker.unexpected_restart`. Repeated kills hit the bounded limit, the worker becomes `error`, and auto-restart stops. |
| 15 | Backup/restore | Create a backup → delete a worker → restore → the worker is back and redeployed with the same secret. |
| 16 | Reboot | `reboot` → panel, workers, tc and iptables rules, and protection state all come back. |
| 17 | Exposure | From outside: `nmap -p 3000,5432,18001 IP` → filtered/closed. Only SSH, 80, 8443 and worker ports are open. |
| 18 | Authorization | `curl -k https://IP:8443/api/workers` without a cookie → 401. |
