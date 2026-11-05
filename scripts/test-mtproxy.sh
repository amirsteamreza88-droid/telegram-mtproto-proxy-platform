#!/bin/bash
# Layered verification for one MTProto worker.
#   sudo bash scripts/test-mtproxy.sh <worker-id>
#
# Layers are reported SEPARATELY. Only a real Telegram client can prove end-to-end
# connectivity, so layer 5 is always printed as NOT VERIFIED unless you pass
# --telegram-client-tested (only after you actually connected with Telegram).
set -uo pipefail
ID=${1:-}
[[ "$ID" =~ ^[0-9]{1,5}$ ]] || { echo "usage: $0 <worker-id> [--telegram-client-tested]"; exit 2; }
CLIENT_TESTED=0; [[ "${2:-}" == "--telegram-client-tested" ]] && CLIENT_TESTED=1

CONF=/etc/mtpanel/workers/$ID.env
[[ -f "$CONF" ]] || { echo "layer 0: no config $CONF (worker $ID not deployed on this host)"; exit 2; }
# shellcheck disable=SC1090
. "$CONF"
: "${PORT:?PORT missing}" "${STATS_PORT:?STATS_PORT missing}" "${SECRET:?SECRET missing}" "${MODE:?MODE missing}"

echo "worker #$ID  mode=$MODE  port=$PORT  stats=$STATS_PORT  ${DOMAIN:+domain=$DOMAIN }${TAG:+sponsor-tag=set}"
echo

echo "[1] process / systemd unit"
if command -v systemctl >/dev/null && systemctl list-unit-files 2>/dev/null | grep -q '^mtproxy@'; then
  systemctl is-active "mtproxy@$ID.service" && echo "    PASS: unit active" || echo "    FAIL: unit not active"
  systemctl show -p MainPID --value "mtproxy@$ID.service"
else
  echo "    NOT AVAILABLE: not running on the managed host (or systemd absent)"
fi

echo "[2] TCP port accepts connections"
if (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then echo "    PASS: 127.0.0.1:$PORT accepts TCP"; exec 3>&- 3<&-; else echo "    FAIL: cannot connect to 127.0.0.1:$PORT"; fi

echo "[3] MTProxy stats endpoint (localhost)"
if stats=$(curl -fsS --max-time 3 "http://127.0.0.1:$STATS_PORT/stats" 2>/dev/null); then
  echo "    PASS: stats endpoint responded:"
  echo "$stats" | grep -E 'total_(max_)?special_connections|uptime' | sed 's/^/      /'
else
  echo "    FAIL: no response from http://127.0.0.1:$STATS_PORT/stats"
fi

echo "[4] protocol-level probe (NOT proof of Telegram login)"
# Send a syntactically plausible but invalid obfuscated init packet; a healthy
# MTProxy answers or resets. This only proves the process speaks MTProto-ish bytes.
resp=$(python3 - "$PORT" <<'PY' 2>/dev/null || echo "error"
import socket, os, sys
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=3)
s.sendall(os.urandom(64))
try:
    data = s.recv(64)
    print(f"server sent {len(data)} bytes / closed cleanly" if data else "server closed without data")
except Exception as e:
    print(f"connection ended: {e}")
PY
)
echo "    $resp"

echo "[5] actual Telegram client connectivity"
if [[ "$CLIENT_TESTED" == 1 ]]; then
  echo "    VERIFIED BY OPERATOR: a real Telegram client connected through this proxy"
else
  echo "    NOT VERIFIED: requires opening the t.me link in a real Telegram client."
  echo "    See docs/TESTING.md acceptance tests #3-#5. TCP/stats/probe checks above do NOT prove this."
fi

echo
echo "[6] EPOLL usage (runtime)"
if command -v systemctl >/dev/null 2>&1; then
  pid=$(systemctl show -p MainPID --value "mtproxy@$ID.service" 2>/dev/null)
  if [[ "$pid" =~ ^[0-9]+$ && "$pid" != 0 ]] && [[ -d /proc/$pid ]]; then
    n=$(find /proc/$pid/fd -maxdepth 1 -lname 'anon_inode:\[eventpoll\]' 2>/dev/null | wc -l)
    echo "    eventpoll fds held by pid $pid: $n  (0 would mean epoll is NOT in use)"
  else
    echo "    NOT AVAILABLE: process not running"
  fi
fi
