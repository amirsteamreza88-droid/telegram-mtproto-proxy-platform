#!/bin/bash
# Command-generation & failure-handling tests for deploy/mtpanel-helper.
# All system binaries (nft, tc, iptables, ip6tables, ip, ufw, ...) are replaced by
# stateful mocks, so these run anywhere without touching the real network stack.
#
# Exit 0 = all passed, 1 = at least one failure, 3 = could not run (SKIP).
set -uo pipefail
cd "$(dirname "$0")/.."
HELPER=deploy/mtpanel-helper

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
MOCK_BIN=$T/bin; MOCK_STATE=$T/state; MOCK_LOG=$T/calls.log
mkdir -p "$MOCK_BIN" "$MOCK_STATE" "$T/conf" "$T/net"
: > "$MOCK_LOG"
export MOCK_LOG MOCK_STATE

# ---------- stateful mock: nft ----------
cat > "$MOCK_BIN/nft" <<'EOF'
#!/bin/bash
echo "nft $*" >> "$MOCK_LOG"
RULES="$MOCK_STATE/nft.rules"
[[ -f "$RULES" ]] || : > "$RULES"
[[ -f "$MOCK_STATE/table" ]] || : > "$MOCK_STATE/table"
[[ -f "$MOCK_STATE/chain" ]] || : > "$MOCK_STATE/chain"
args="$*"
if [[ "${MOCK_FAIL_NFT:-0}" == 1 && "$args" == *"add rule"* ]]; then echo "mock nft: permission denied" >&2; exit 1; fi
if [[ -n "${MOCK_FAIL_PORT:-}" && "$args" == *"dport $MOCK_FAIL_PORT "* ]]; then echo "mock nft: fail for port $MOCK_FAIL_PORT" >&2; exit 1; fi
case "$args" in
  "add table inet "* ) echo 1 > "$MOCK_STATE/table"; exit 0 ;;
  "add chain inet "* ) echo 1 > "$MOCK_STATE/chain"; exit 0 ;;
  "list table inet "*) [[ -s "$MOCK_STATE/table" ]] && exit 0 || exit 1 ;;
  "list chain inet "*) [[ -s "$MOCK_STATE/chain" ]] && exit 0 || exit 1 ;;
  "-a list chain inet "*)
    [[ -s "$MOCK_STATE/chain" ]] || exit 1
    n=0; while IFS= read -r line; do n=$((n+1)); echo "$line # handle $n"; done < "$RULES"
    exit 0 ;;
  "add rule inet "*)
    # extract comment "mtp-global-N"
    c=$(echo "$args" | grep -o 'comment "[^"]*"')
    echo "$args $c" >> "$RULES"; exit 0 ;;
  "delete rule inet "*)
    h=$(echo "$args" | awk '{for(i=1;i<=NF;i++) if($i=="handle") print $(i+1)}')
    tmp="$RULES.tmp"; n=0; : > "$tmp"
    while IFS= read -r line; do n=$((n+1)); [[ "$n" == "$h" ]] || echo "$line" >> "$tmp"; done < "$RULES"
    mv "$tmp" "$RULES"; exit 0 ;;
esac
exit 0
EOF

# ---------- mock: tc (fails on ipv6 when MOCK_FAIL_TC_V6=1) ----------
cat > "$MOCK_BIN/tc" <<'EOF'
#!/bin/bash
echo "tc $*" >> "$MOCK_LOG"
args="$*"
if [[ "${MOCK_FAIL_TC_V6:-0}" == 1 && "$args" == *"ipv6"* && "$args" != *"show"* ]]; then echo "mock tc: ipv6 filter failed" >&2; exit 2; fi
if [[ "${MOCK_FAIL_TC:-0}" == 1 && "$args" != *"show"* ]]; then exit 2; fi
exit 0
EOF

# ---------- mock: ip (stateful ifb0) ----------
cat > "$MOCK_BIN/ip" <<'EOF'
#!/bin/bash
echo "ip $*" >> "$MOCK_LOG"
args="$*"
case "$args" in
  "-o -4 route show default") echo "default via 10.0.0.1 dev eth0"; exit 0 ;;
  "link show ifb0") [[ -f "$MOCK_STATE/ifb0" ]] && exit 0 || exit 1 ;;
  "link add ifb0 type ifb") [[ "${MOCK_FAIL_IFB:-0}" == 1 ]] && { echo "mock: cannot create ifb" >&2; exit 1; }; : > "$MOCK_STATE/ifb0"; exit 0 ;;
esac
exit 0
EOF

# ---------- mocks: iptables / ip6tables ----------
for t in iptables ip6tables; do cat > "$MOCK_BIN/$t" <<EOF
#!/bin/bash
echo "$t \$*" >> "\$MOCK_LOG"
args="\$*"
if [[ "\${MOCK_FAIL_IPT:-0}" == 1 && ( "\$args" == *" -A "* || "\$args" == *" -I "* ) ]]; then exit 1; fi
exit 0
EOF
done

# ---------- trivial mocks ----------
for t in ufw modprobe systemctl; do printf '#!/bin/bash\necho "%s $*" >> "$MOCK_LOG"\nexit 0\n' "$t" > "$MOCK_BIN/$t"; done
# ufw status must look active for ufw_sync to run
printf '#!/bin/bash\necho "ufw $*" >> "$MOCK_LOG"\n[[ "$*" == "status" ]] && echo "Status: active"\nexit 0\n' > "$MOCK_BIN/ufw"
chmod +x "$MOCK_BIN"/*

run_helper() { # stdin-state... ; env via environment
  MTP_PATH="$MOCK_BIN:/usr/sbin:/usr/bin:/sbin:/bin" MTP_CONF_DIR=$T/conf MTP_NET_DIR=$T/net bash "$HELPER" "$@"
}

PASS=0; FAIL=0
ok()  { echo "ok   - $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL - $1"; FAIL=$((FAIL+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi }

net_input() { printf 'PORT=%s\nDOWN=%s\nUP=%s\nTOTAL=%s\nPERIP=%s\nBLOCKS=%s\n' "$1" "${2:-0}" "${3:-0}" "${4:-0}" "${5:-0}" "${6:-}"; }

reset_state() { rm -f "$MOCK_STATE"/* ; : > "$MOCK_LOG"; rm -f "$T/net"/*; }

echo "== helper network command-generation tests =="

# 1. full success
reset_state
out=$(net_input 8443 10000 5000 100 64 "" | run_helper net-apply 7); rc=$?
check "net-apply exits 0 on full success" "[[ \$rc -eq 0 ]]"
check "NETSTATUS line printed" "echo \"\$out\" | grep -q '^NETSTATUS '"
check "all components ok" "echo \"\$out\" | grep -q 'tc_v4=ok tc_v6=ok ifb_v4=ok ifb_v6=ok nft_global=ok ip4_fw=ok ip6_fw=ok'"
check "global limit rule created in inet table with one shared ct counter" "grep -q 'table inet' \$MOCK_STATE/nft.rules 2>/dev/null; grep -q 'ct count over 100' \$MOCK_STATE/nft.rules && grep -q 'mtp-global-7' \$MOCK_STATE/nft.rules"
check "rule lives in inet family (single counter shared by IPv4+IPv6)" "grep -q 'add rule inet mtpanel input' \$MOCK_LOG"
check "exactly one nft rule for the worker" "[[ \$(grep -c 'mtp-global-7' \$MOCK_STATE/nft.rules) -eq 1 ]]"
check "ipv4 and ipv6 egress filters both added" "grep -q 'protocol ip prio' \$MOCK_LOG && grep -q 'protocol ipv6 prio' \$MOCK_LOG"
check "ipv4 and ipv6 ifb filters both added" "[[ \$(grep -c 'dev ifb0' \$MOCK_LOG) -ge 4 ]]"
check "per-IP connlimit rule added for ipv4" "grep -q 'connlimit-above 64' \$MOCK_LOG"
check "state + status files written" "[[ -f \$T/net/7.net && -f \$T/net/7.status ]]"

# 2. reapply does not duplicate rules
out=$(net_input 8443 10000 5000 100 64 "" | run_helper net-apply 7); rc=$?
check "reapply exits 0" "[[ \$rc -eq 0 ]]"
check "reapply deletes old rule before adding (idempotent)" "grep -q 'delete rule inet mtpanel input handle' \$MOCK_LOG"
check "still exactly one rule after reapply" "[[ \$(grep -c 'mtp-global-7' \$MOCK_STATE/nft.rules) -eq 1 ]]"

# 3. two workers have independent counters
net_input 8444 0 0 50 0 "" | run_helper net-apply 8 >/dev/null
check "second worker gets its own rule/counter" "[[ \$(grep -c 'mtp-global-8' \$MOCK_STATE/nft.rules) -eq 1 ]] && grep -q 'ct count over 50' \$MOCK_STATE/nft.rules"
check "worker rules are separate" "[[ \$(grep -c 'ct count over' \$MOCK_STATE/nft.rules) -eq 2 ]]"

# 4. nftables failure: NOT silently ok; iptables per-family fallback engages and is labeled
reset_state
out=$(net_input 8443 10000 5000 100 64 "" | MOCK_FAIL_NFT=1 run_helper net-apply 7); rc=$?
check "nft failure -> non-zero exit (3 = partial)" "[[ \$rc -eq 3 ]]"
check "nft_global reported as fallback (never silently ok)" "echo \"\$out\" | grep -q 'nft_global=fallback-iptables-per-family'"
check "iptables fallback global rule uses mask 0 (one group)" "grep -q 'connlimit-above 100 --connlimit-mask 0' \$MOCK_LOG"
check "tc components still ok (preserved)" "echo \"\$out\" | grep -q 'tc_v4=ok'"
check "no nft rule installed" "[[ ! -s \$MOCK_STATE/nft.rules ]] || ! grep -q 'mtp-global-7' \$MOCK_STATE/nft.rules"
check "status file records the fallback" "grep -q 'nft_global=fallback-iptables-per-family' \$T/net/7.status"

# 4b. nft AND iptables both fail -> global limit reported failed, partial preserved
reset_state
out=$(net_input 8443 10000 5000 100 64 "" | MOCK_FAIL_NFT=1 MOCK_FAIL_IPT=1 run_helper net-apply 7); rc=$?
check "total failure of global limit -> exit 3 (tc still ok)" "[[ \$rc -eq 3 ]]"
check "nft_global=failed reported honestly" "echo \"\$out\" | grep -q 'nft_global=failed'"
check "fw not reported as ok (total rule NOT in effect)" "! echo \"\$out\" | grep -q 'ip4_fw=ok'"
check "tc still enforced (preserved)" "echo \"\$out\" | grep -q 'tc_v4=ok tc_v6=ok'"

# 5. IPv6-only tc failure
reset_state
out=$(net_input 8443 10000 5000 100 0 "" | MOCK_FAIL_TC_V6=1 run_helper net-apply 7); rc=$?
check "ipv6 tc failure -> exit 3" "[[ \$rc -eq 3 ]]"
check "tc_v6=failed, tc_v4=ok (independent)" "echo \"\$out\" | grep -q 'tc_v4=ok tc_v6=failed'"
check "ifb_v6=failed, ifb_v4=ok (independent)" "echo \"\$out\" | grep -q 'ifb_v4=ok ifb_v6=failed'"
check "nft_global still ok" "echo \"\$out\" | grep -q 'nft_global=ok'"

# 6. ifb unavailable -> upload shaping reported failed, download still works
reset_state
out=$(net_input 8443 10000 5000 0 0 "" | MOCK_FAIL_IFB=1 run_helper net-apply 7); rc=$?
check "ifb failure -> exit 3" "[[ \$rc -eq 3 ]]"
check "ifb_v4=failed ifb_v6=failed (upload NOT claimed enforced)" "echo \"\$out\" | grep -q 'ifb_v4=failed ifb_v6=failed'"
check "tc_v4=ok (download preserved)" "echo \"\$out\" | grep -q 'tc_v4=ok'"

# 7. TOTAL=0 -> global limit off, no rule
reset_state
out=$(net_input 8443 0 0 0 0 "" | run_helper net-apply 7); rc=$?
check "TOTAL=0 -> nft_global=off, exit 0" "[[ \$rc -eq 0 ]] && echo \"\$out\" | grep -q 'nft_global=off'"
check "no global rule installed when TOTAL=0" "! grep -q 'mtp-global-7' \$MOCK_STATE/nft.rules"

# 8. remove cleans up nft rules
net_input 8443 0 0 100 0 "" | run_helper net-apply 7 >/dev/null
out=$(run_helper remove 7); rc=$?
check "remove exits 0" "[[ \$rc -eq 0 ]]"
check "worker nft rule deleted on remove" "! grep -q 'mtp-global-7' \$MOCK_STATE/nft.rules"
check "remove reports leftover count (0)" "echo \"\$out\" | grep -q 'nft_rules_left=0'"
check "state files removed" "[[ ! -f \$T/net/7.net ]]"

# 9. invalid input rejected, nothing applied
reset_state
out=$(printf 'PORT=abc\nDOWN=0\nUP=0\nTOTAL=0\nPERIP=0\nBLOCKS=\n' | run_helper net-apply 7 2>&1); rc=$?
check "invalid port -> non-zero exit" "[[ \$rc -ne 0 ]]"
check "invalid port -> error message" "echo \"\$out\" | grep -qi 'invalid port'"
check "invalid input -> no state written" "[[ ! -f \$T/net/7.net ]]"
out=$(printf 'PORT=8443\nDOWN=0\nUP=0\nTOTAL=0\nPERIP=0\nBLOCKS=1.2.3.4;rm -rf /\n' | run_helper net-apply 7 2>&1); rc=$?
check "injection attempt in BLOCKS rejected" "[[ \$rc -ne 0 ]] && echo \"\$out\" | grep -qi 'invalid ipv4'"

# 10. boot-time restore-all: honest per-worker results and exit codes
reset_state
printf 'PORT=8443\nDOWN=0\nUP=0\nTOTAL=100\nPERIP=0\nBLOCKS=\n' > "$T/net/7.net"
printf 'PORT=8444\nDOWN=0\nUP=0\nTOTAL=50\nPERIP=0\nBLOCKS=\n' > "$T/net/8.net"
out=$(run_helper restore-all); rc=$?
check "restore-all: all workers ok -> exit 0" "[[ \$rc -eq 0 ]]"
check "restore-all: per-worker NETSTATUS lines preserved" "[[ \$(echo \"\$out\" | grep -c '^NETSTATUS ') -eq 2 ]]"
check "restore-all: summary line reports counts" "echo \"\$out\" | grep -q 'RESTORE_DONE workers=2 ok=2 failed=0 exit=0'"

reset_state
printf 'PORT=8443\nDOWN=0\nUP=0\nTOTAL=100\nPERIP=0\nBLOCKS=\n' > "$T/net/7.net"
printf 'PORT=8444\nDOWN=0\nUP=0\nTOTAL=50\nPERIP=0\nBLOCKS=\n' > "$T/net/8.net"
out=$(MOCK_FAIL_PORT=8444 run_helper restore-all); rc=$?
check "restore-all: one worker fails -> exit 3 (partial), systemd can detect" "[[ \$rc -eq 3 ]]"
check "restore-all: failed worker reported not-ok (fallback), other ok" "echo \"\$out\" | grep -q 'id=8 .*nft_global=fallback-iptables-per-family' && echo \"\$out\" | grep -q 'id=7 .*nft_global=ok'"
check "restore-all: summary shows 1 ok 1 failed" "echo \"\$out\" | grep -q 'ok=1 failed=1 exit=3'"

# retry after failure: succeeds, no duplicate rules
out=$(run_helper restore-all); rc=$?
check "restore-all retry after failure -> exit 0" "[[ \$rc -eq 0 ]]"
check "restore-all retry does not duplicate rules" "[[ \$(grep -c 'ct count over' \$MOCK_STATE/nft.rules) -eq 2 ]]"

# all workers fail -> exit 1
reset_state
printf 'PORT=8443\nDOWN=0\nUP=0\nTOTAL=100\nPERIP=0\nBLOCKS=\n' > "$T/net/7.net"
out=$(MOCK_FAIL_NFT=1 MOCK_FAIL_IPT=1 MOCK_FAIL_TC=1 run_helper restore-all); rc=$?
check "restore-all: total failure -> exit 1" "[[ \$rc -eq 1 ]]"
check "restore-all: summary shows all failed" "echo \"\$out\" | grep -q 'ok=0 failed=1 exit=1'"

# corrupt state file does not abort other workers
reset_state
printf 'PORT=8443\nDOWN=0\nUP=0\nTOTAL=100\nPERIP=0\nBLOCKS=\n' > "$T/net/7.net"
printf 'PORT=notaport\nDOWN=0\nUP=0\nTOTAL=0\nPERIP=0\nBLOCKS=\n' > "$T/net/9.net"
out=$(run_helper restore-all); rc=$?
check "restore-all: corrupt worker skipped, healthy worker still restored (exit 3)" "[[ \$rc -eq 3 ]] && echo \"\$out\" | grep -q 'id=7 .*nft_global=ok'"

echo
echo "helper-net tests: pass=$PASS fail=$FAIL"
[[ $FAIL -eq 0 ]]
