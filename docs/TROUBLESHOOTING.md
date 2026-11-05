# Troubleshooting

Start with: `sudo bash deploy/doctor.sh` and **Settings → Installation diagnostics**.

| Symptom | Cause / fix |
|---|---|
| Installer: "Ubuntu 24.04 LTS is required" | Use Ubuntu 24.04. Set `MTPANEL_ALLOW_UNSUPPORTED=1` to try another OS at your own risk. |
| Installer: port in use | Choose another one with `--panel-port` / `--backend-port`, or stop the conflicting service (`ss -tlnp`). |
| Browser certificate warning | You are using the self-signed fallback. Use `--domain`, or make sure TCP 80 is reachable for a Let's Encrypt IP certificate, then re-run `install.sh`. |
| Dashboard shows "Host agent unavailable" | Run `sudo -u mtpanel sudo -n /usr/local/sbin/mtpanel-helper ping`. It must print `pong`. Re-run `install.sh` to reinstall the sudoers rule. |
| Worker `failed`: "Port … already in use" | Another process (often nginx or a web server on 443) is listening. Pick another port or free it. |
| Worker `failed`: service not active | Open **View logs**. Common causes: missing `/var/lib/mtproxy/proxy-multi.conf` (run `systemctl start mtproxy-config-update`), or a crash from `pid_max` (see below). |
| MTProxy crash `Assertion … pid` | `cat /proc/sys/kernel/pid_max` must be ≤ 65535. Run `sysctl -p /etc/sysctl.d/99-mtpanel.conf`, or re-run install without `--keep-pid-max`. |
| Fake-TLS domain validation failed | The domain must resolve from the VPS and serve TLS 1.3 on 443. Choose a large, stable site. |
| Clients cannot connect, service healthy | Check the cloud provider's firewall or security group (it is outside the VPS). Check `ufw status`. Behind NAT, make sure `/etc/mtpanel/public_ip` holds the real public IP (it is used for `--nat-info`). |
| Upload limit has no effect | The `ifb` module is missing: run `modprobe ifb`. Some container-based VPS kernels lack it. Use a KVM VPS. |
| Per-worker CPU/RAM shows "—" | The worker is stopped, or cgroup v2 is not available. Check `ls /sys/fs/cgroup/system.slice/system-mtproxy.slice/`. |
| Restore of an uploaded backup fails | In-app backups need the same `APP_SECRET_KEY` as the server that created them. Copy the key into `/etc/mtpanel/panel.env` and restart. |
| Forgot admin password | See "Reset admin password" in the README. |
| Update failed | update.sh rolls back automatically: the release symlink, the DB snapshot and the host components. Snapshots are in `/var/lib/mtpanel/backups/pre-update-*`. |
| Panel logs | `journalctl -u mtpanel -f` |
| Worker logs | `journalctl -u mtproxy@<id> -f` |
| Network rules | `iptables -S MTPANEL`, `tc -s class show dev <iface>`, `tc -s class show dev ifb0` |
