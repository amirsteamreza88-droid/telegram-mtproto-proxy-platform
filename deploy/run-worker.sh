#!/bin/bash
# Launches one MTProxy worker. Executed by mtproxy@<id>.service as the unprivileged
# 'mtproxy' user; config comes from /etc/mtpanel/workers/<id>.env (EnvironmentFile).
set -euo pipefail
: "${PORT:?}" "${STATS_PORT:?}" "${SECRET:?}" "${MODE:?}"
BIN=/opt/mtproxy/mtproto-proxy
DATA=/var/lib/mtproxy
# Real MTProxy flags (see mtproto-proxy.c parse options): there is NO -R flag.
# Server-side, "secure" (dd) and "classic" are identical (-S plain secret); the
# dd prefix only changes the CLIENT link format. -D <domain> switches the server
# to fake-TLS-only transport (allow_only_tls). --http-stats enables the HTTP
# stats endpoint the panel reads. -C is the proxy's own per-worker connection cap.
ARGS=(-p "$STATS_PORT" -H "$PORT" -S "$SECRET" --http-stats --aes-pwd "$DATA/proxy-secret")
case "$MODE" in
  secure|classic) ;;
  faketls) ARGS+=(-D "${DOMAIN:?DOMAIN required for faketls}") ;;
  *) echo "invalid MODE" >&2; exit 2 ;;
esac
if [[ -n "${MAXCONN:-}" && "$MAXCONN" != 0 ]]; then ARGS+=(-C "$MAXCONN"); fi
if [[ -n "${TAG:-}" ]]; then ARGS+=(-P "$TAG"); fi
# Behind 1:1 NAT (common on cloud VPS) MTProxy must know local and public addresses.
LOCAL_IP=$(ip -o -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
PUBLIC_IP=$(cat /etc/mtpanel/public_ip 2>/dev/null || true)
if [[ -n "$LOCAL_IP" && -n "$PUBLIC_IP" && "$LOCAL_IP" != "$PUBLIC_IP" ]]; then
  ARGS+=(--nat-info "$LOCAL_IP:$PUBLIC_IP")
fi
exec "$BIN" "${ARGS[@]}" "$DATA/proxy-multi.conf"
