#!/bin/bash
# Downloads the Telegram DC configuration. Files are replaced only when the download
# succeeded and looks valid, so a network failure never breaks running workers.
set -euo pipefail
D=/var/lib/mtproxy
mkdir -p "$D"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsS --max-time 30 https://core.telegram.org/getProxySecret -o "$tmp/proxy-secret"
curl -fsS --max-time 30 https://core.telegram.org/getProxyConfig -o "$tmp/proxy-multi.conf"
[[ -s "$tmp/proxy-secret" ]] || { echo "empty proxy-secret" >&2; exit 1; }
grep -q '^proxy_for' "$tmp/proxy-multi.conf" || { echo "invalid proxy-multi.conf" >&2; exit 1; }
install -m 0644 "$tmp/proxy-secret" "$D/proxy-secret"
install -m 0644 "$tmp/proxy-multi.conf" "$D/proxy-multi.conf"
echo "Telegram proxy configuration updated"
