#!/bin/bash
# Installation diagnostics.  sudo bash deploy/doctor.sh
set -uo pipefail
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "$SRC_DIR/deploy/lib.sh"
require_root
. /etc/os-release; echo "OS:            $PRETTY_NAME   kernel $(uname -r)"
echo "Node.js:       $(node -v 2>/dev/null || echo missing)"
[[ -f "$INSTALL_CONF" ]] && . "$INSTALL_CONF" || { echo "MTPanel not installed"; exit 1; }
load_panel_env
echo "Release:       $(readlink -f "$CURRENT")"
for s in mtpanel postgresql nginx mtpanel-netrules mtproxy-config-update.timer; do
  printf '%-14s %s\n' "$s:" "$(systemctl is-active "$s")"
done
printf '%-14s %s\n' "Backend:" "$(curl -fsS --max-time 4 "http://127.0.0.1:$PORT/api/health" || echo FAILED)"
printf '%-14s %s\n' "HTTPS:" "$(curl -fsSk --max-time 4 -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PANEL_PORT/api/health" || echo FAILED)"
printf '%-14s %s\n' "Helper:" "$(sudo -u mtpanel sudo -n /usr/local/sbin/mtpanel-helper ping 2>&1)"
echo; echo "Host checks:"; /usr/local/sbin/mtpanel-helper doctor
echo; echo "Exposed listeners (non-loopback):"
ss -Htlnp | awk '$4 !~ /^(127\.|\[::1\])/' | sed 's/^/  /'
echo; echo "Workers:"
for u in $(systemctl list-units --all --plain --no-legend 'mtproxy@*' | awk '{print $1}'); do
  printf '  %-24s %s\n' "$u" "$(systemctl is-active "$u")"
done
CERT=$(awk '/ssl_certificate /{print $2}' /etc/nginx/sites-available/mtpanel.conf 2>/dev/null | head -1 | tr -d ';')
[[ -n "$CERT" ]] && echo && echo "Certificate:   $CERT – expires $(openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)"
echo; echo "Recent panel errors:"; journalctl -u mtpanel -p err -n 10 --no-pager 2>/dev/null | sed 's/^/  /'
