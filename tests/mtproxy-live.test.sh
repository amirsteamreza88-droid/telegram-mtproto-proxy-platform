#!/bin/bash
# Live MTProxy tests with the REAL binary. Layers are reported separately:
#   [1] process startup  [2] TCP port  [3] stats endpoint  [4] protocol-level handshake
#   [5] actual Telegram client connectivity -> always NOT VERIFIED here.
# Uses the real binary (env MTPROXY_BIN or /opt/mtproxy/mtproto-proxy or a local build).
# Exit 0 = pass, 1 = fail, 3 = SKIP (binary/config/network unavailable).
set -uo pipefail
cd "$(dirname "$0")/.."

pkill -x mtproto-proxy 2>/dev/null; sleep 1
BASE=$((20000 + $$ % 20000))
P1P=$BASE; P2P=$((BASE+1)); P3P=$((BASE+2)); S1P=$((BASE+100)); S2P=$((BASE+101)); S3P=$((BASE+102))
BIN=${MTPROXY_BIN:-}
for c in "$BIN" /opt/mtproxy/mtproto-proxy /tmp/mtproxy-src/objs/bin/mtproto-proxy; do
  [[ -n "$c" && -x "$c" ]] && BIN=$c && break
done
[[ -n "$BIN" && -x "$BIN" ]] || { echo "SKIP: no MTProxy binary (set MTPROXY_BIN)"; exit 3; }

T=$(mktemp -d); trap 'kill $P1 $P2 $P3 2>/dev/null; rm -rf "$T"' EXIT
D=$T/data; mkdir -p "$D"
if [[ ! -s /tmp/mtp-data/proxy-secret ]]; then
  curl -fsS --max-time 20 https://core.telegram.org/getProxySecret -o "$D/proxy-secret" 2>/dev/null || { echo "SKIP: cannot download proxy-secret"; exit 3; }
  curl -fsS --max-time 20 https://core.telegram.org/getProxyConfig -o "$D/proxy-multi.conf" 2>/dev/null || { echo "SKIP: cannot download proxy-multi.conf"; exit 3; }
else
  cp /tmp/mtp-data/proxy-secret /tmp/mtp-data/proxy-multi.conf "$D/"
fi

S1=0123456789abcdef0123456789abcdef   # classic
S2=aabbccddeeff00112233445566778899   # dd (secure, -R)
S3=11223344556677889900aabbccddeeff   # ee (fake-TLS, -D)
DOMAIN=www.cloudflare.com

"$BIN" -p $S1P -H $P1P -S "$S1" --http-stats -v --aes-pwd "$D/proxy-secret" "$D/proxy-multi.conf" >"$T/l1.log" 2>&1 & P1=$!
# secure/dd mode: server args identical to classic (no -R flag exists in MTProxy)
"$BIN" -p $S2P -H $P2P -S "$S2" --http-stats -v --aes-pwd "$D/proxy-secret" "$D/proxy-multi.conf" >"$T/l2.log" 2>&1 & P2=$!
"$BIN" -p $S3P -H $P3P -S "$S3" --http-stats -v -D "$DOMAIN" --aes-pwd "$D/proxy-secret" "$D/proxy-multi.conf" >"$T/l3.log" 2>&1 & P3=$!
sleep 2

PASS=0; FAIL=0
ok()  { echo "ok   - $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL - $1"; FAIL=$((FAIL+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi }
showlogs() { for f in "$T"/l*.log; do echo "--- $f"; tail -3 "$f"; done; }

echo "== live MTProxy tests (binary: $BIN) =="
echo "layers: [1] process  [2] TCP port  [3] stats  [4] protocol handshake  [5] Telegram client = NOT VERIFIED"

# [1] process startup
for i in 1 2 3; do
  pvar=P$i; pid=${!pvar}
  check "[$i] process running (pid $pid)" "kill -0 $pid 2>/dev/null"
done
check "classic cmdline: -S secret, --http-stats, no -D" "tr '\\0' ' ' < /proc/$P1/cmdline | grep -q -- '-S 0123456789abcdef0123456789abcdef' && tr '\\0' ' ' < /proc/$P1/cmdline | grep -q -- '--http-stats' && ! tr '\\0' ' ' < /proc/$P1/cmdline | grep -q -- '-D'"
check "secure cmdline: identical to classic (no -R exists)" "tr '\\0' ' ' < /proc/$P2/cmdline | grep -q -- '-S aabbccddeeff00112233445566778899' && ! tr '\\0' ' ' < /proc/$P2/cmdline | grep -q -- '-R'"
check "faketls cmdline has -D $DOMAIN" "tr '\\0' ' ' < /proc/$P3/cmdline | grep -q -- '-D' && tr '\\0' ' ' < /proc/$P3/cmdline | grep -q -- "$DOMAIN""
check "all cmdlines include --http-stats" "for p in $P1 $P2 $P3; do tr '\\0' ' ' < /proc/\$p/cmdline | grep -q -- '--http-stats' || exit 1; done"

# [2] TCP port
for port in $P1P $P2P $P3P; do
  check "[2] port $port accepts TCP" "(exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null"
done

# [3] stats endpoint
for sp in $S1P $S2P $S3P; do
  check "[3] stats endpoint :$sp responds" "curl -fsS --max-time 3 http://127.0.0.1:$sp/stats | grep -q total_"
done

# [4] protocol-level handshake. The obfuscated2 header is built exactly as the server
# source expects (see tests/mtproxy-probe.py); the deterministic oracle is the
# MTProxy log itself (vkprintf level 1).
probe() { python3 tests/mtproxy-probe.py "$@"; }
probe $P1P $S1 dd;  sleep 1
check "[4] classic: valid obfuscated2 header ACCEPTED by server" "grep -q 'opportunistic encryption mode detected, tag = dddddddd' "$T/l1.log""
probe $P1P $S1 xx;  sleep 1
check "[4] classic: garbage header REJECTED" "grep -q 'invalid .random. 64-byte header' "$T/l1.log""
probe $P2P $S2 dd;  sleep 1
check "[4] secure(dd): dd-tag header ACCEPTED (server config identical to classic)" "grep -q 'opportunistic encryption mode detected, tag = dddddddd' "$T/l2.log""
probe $P2P $S2 xx;  sleep 1
check "[4] secure(dd): garbage header REJECTED" "grep -q 'invalid .random. 64-byte header' "$T/l2.log""
probe $P3P $S3 tls $DOMAIN; sleep 1
check "[4] faketls(-D): TLS ClientHello with SNI=$DOMAIN reaches the domain handler" "grep -q 'TLS type with domain www.cloudflare.com' "$T/l3.log""
probe $P3P $S3 tls wrong.example.com; sleep 1
check "[4] faketls(-D): wrong SNI not matched to any configured domain" "! grep -q 'TLS type with domain wrong.example.com' "$T/l3.log""
probe $P3P $S3 dd; sleep 1
check "[4] faketls(-D): plain obfuscated header rejected (TLS-only mode)" "grep -q 'Expected TLS-transport' "$T/l3.log""

# [5]
echo "[5] actual Telegram client connectivity: NOT VERIFIED (needs a real Telegram client; docs/TESTING.md #3-#5)"

echo
[[ $FAIL -gt 0 ]] && showlogs
echo "mtproxy-live: pass=$PASS fail=$FAIL"
[[ $FAIL -eq 0 ]]
