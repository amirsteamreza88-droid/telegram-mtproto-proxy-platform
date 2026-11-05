#!/bin/bash
# Remove MTPanel.  --purge also deletes the database, configuration, backups and users.
set -euo pipefail
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "$SRC_DIR/deploy/lib.sh"
require_root
PURGE=0; [[ "${1:-}" == "--purge" ]] && PURGE=1
read -rp "Uninstall MTPanel and stop all proxy workers? Type UNINSTALL: " a; [[ "$a" == UNINSTALL ]] || die "aborted"

log "Stopping panel and workers"
systemctl disable --now mtpanel.service 2>/dev/null || true
for f in /etc/mtpanel/workers/*.env; do
  [[ -e "$f" ]] || continue
  /usr/local/sbin/mtpanel-helper remove "$(basename "$f" .env)" || true
done
iptables -w -D INPUT -j MTPANEL 2>/dev/null || true; iptables -w -F MTPANEL 2>/dev/null || true; iptables -w -X MTPANEL 2>/dev/null || true
ip6tables -w -D INPUT -j MTPANEL 2>/dev/null || true; ip6tables -w -F MTPANEL 2>/dev/null || true; ip6tables -w -X MTPANEL 2>/dev/null || true
IF=$(ip -o -4 route show default | awk '{print $5; exit}')
[[ -n "$IF" ]] && { tc qdisc del dev "$IF" root 2>/dev/null || true; tc qdisc del dev "$IF" ingress 2>/dev/null || true; }
ip link del ifb0 2>/dev/null || true

systemctl disable --now mtpanel-netrules.service mtproxy-config-update.timer 2>/dev/null || true
rm -f /etc/systemd/system/{mtproxy@.service,mtpanel.service,mtpanel-netrules.service,mtproxy-config-update.service,mtproxy-config-update.timer}
systemctl daemon-reload
rm -f /etc/sudoers.d/mtpanel /usr/local/sbin/mtpanel-helper /etc/sysctl.d/99-mtpanel.conf
rm -rf /usr/local/lib/mtpanel
rm -f /etc/nginx/sites-enabled/mtpanel.conf /etc/nginx/sites-available/mtpanel.conf
nginx -t -q 2>/dev/null && systemctl reload nginx || true
if [[ -f "$INSTALL_CONF" ]]; then . "$INSTALL_CONF"; ufw delete allow "$PANEL_PORT/tcp" >/dev/null 2>&1 || true; fi
rm -rf "$PREFIX" /opt/mtproxy

if [[ $PURGE == 1 ]]; then
  log "Purging database, configuration, backups and service accounts"
  sudo -u postgres dropdb --if-exists mtpanel || true
  sudo -u postgres psql -qc "DROP ROLE IF EXISTS mtpanel" || true
  rm -rf "$ETC" "$VAR" /var/lib/mtproxy /var/www/mtpanel-acme
  userdel mtpanel 2>/dev/null || true; userdel mtproxy 2>/dev/null || true
else
  log "Kept: database 'mtpanel', $ETC (incl. APP_SECRET_KEY) and $VAR/backups. Use --purge to remove."
fi
log "MTPanel removed. PostgreSQL, nginx and Node.js packages were left installed."
