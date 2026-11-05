#!/bin/bash
# Real integration test of the helper's network layer inside an isolated network
# namespace (unshare -rn) with the REAL nft/tc/iptables binaries. No host rules are
# touched. Capability-aware: tc/ifb/connlimit/ct-count assertions run when the
# kernel supports them; otherwise the test verifies the helper REPORTS the
# limitation honestly instead of claiming success.
# Exit 0 = pass, 1 = fail, 3 = skipped (no namespace support).
set -uo pipefail
cd "$(dirname "$0")/.."

if ! unshare -rn true 2>/dev/null; then
  echo "SKIP: cannot create network namespaces in this environment"
  exit 3
fi

unshare -rn bash -s <<'OUTER'
set -uo pipefail
HELPER="$(pwd)/deploy/mtpanel-helper"
T=$(mktemp -d)
export MTP_CONF_DIR=$T/conf MTP_NET_DIR=$T/net
mkdir -p "$MTP_CONF_DIR" "$MTP_NET_DIR"
PASS=0; FAIL=0
ok()  { echo "ok   - $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL - $1"; FAIL=$((FAIL+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi }

ip link set lo up
ip link add dummy0 type dummy 2>/dev/null
ip addr add 10.99.0.1/24 dev dummy0
ip link set dummy0 up
ip route add default dev dummy0

# capability probes
TC_OK=0; tc qdisc add dev lo root fq_codel 2>/dev/null && TC_OK=1
IFB_OK=0; ip link add ifb0 type ifb 2>/dev/null && IFB_OK=1
CL_OK=0; iptables -N CLPROBE 2>/dev/null && iptables -A CLPROBE -m connlimit --connlimit-above 1 --connlimit-mask 0 -j REJECT 2>/dev/null && CL_OK=1; iptables -F CLPROBE 2>/dev/null; iptables -X CLPROBE 2>/dev/null
NFT_CT_OK=0; nft add table inet probe 2>/dev/null && nft add chain inet probe input '{ type filter hook input priority filter; policy accept; }' 2>/dev/null && nft add rule inet probe input tcp dport 9999 ct state new ct count over 5 counter drop 2>/dev/null && NFT_CT_OK=1; nft delete table inet probe 2>/dev/null
echo "capabilities: tc=$TC_OK ifb=$IFB_OK connlimit=$CL_OK nft_ct_count=$NFT_CT_OK"

net_input() { printf 'PORT=%s\nDOWN=%s\nUP=%s\nTOTAL=%s\nPERIP=%s\nBLOCKS=%s\n' "$1" "${2:-0}" "${3:-0}" "${4:-0}" "${5:-0}" "${6:-}"; }
run() { net_input "$@" | bash "$HELPER" net-apply 3; }

echo "== netns integration tests (real nft/tc/iptables, isolated namespace) =="

out=$(run 8443 10000 5000 100 64 ""); rc=$?
check "net-apply prints NETSTATUS" "echo \"\$out\" | grep -q '^NETSTATUS '"
check "exit code honest: 0 only if everything applied, otherwise 1/3 (never silent)" "[[ \$rc -eq 0 ]] && echo \"\$out\" | grep -q 'nft_global=ok' || [[ \$rc -eq 1 || \$rc -eq 3 ]]"
g=$(echo "$out" | grep -o 'nft_global=[a-z-]*' | cut -d= -f2)
if [[ "$NFT_CT_OK" == 1 ]]; then
  check "on ct-count kernels: single inet rule = one counter shared by IPv4+IPv6" "[[ \"\$g\" == ok ]] && [[ \$(nft list chain inet mtpanel input 2>/dev/null | grep -c 'ct count over') -eq 1 ]] && nft list table inet mtpanel | grep -q 'mtp-global-3'"
else
  check "on kernels without ct count: nft_global honestly NOT ok (failed or labeled fallback)" "[[ \"\$g\" == failed || \"\$g\" == fallback-iptables-per-family ]]"
fi
if [[ "$CL_OK" == 1 && "$g" == fallback-iptables-per-family ]]; then
  check "iptables fallback installed with mask 0 (one global group per family)" "iptables -w -S MTPW3 2>/dev/null | grep -q 'connlimit-above 100' && iptables -w -S MTPW3 | grep -q 'connlimit-mask 0'"
fi
if [[ "$TC_OK" == 1 ]]; then
  check "tc egress filter for the worker port installed" "tc filter show dev dummy0 parent 1: 2>/dev/null | grep -q 'sport 8443'"
  check "tc v4 and v6 filters both present" "[[ \$(tc filter show dev dummy0 parent 1: 2>/dev/null | grep -c 'sport 8443') -eq 2 ]]"
else
  check "tc limitation reported honestly (tc_v4 != ok)" "! echo \"\$out\" | grep -q 'tc_v4=ok'"
fi
if [[ "$TC_OK" == 1 && "$IFB_OK" == 1 ]]; then
  check "upload shaping on ifb0 installed" "tc filter show dev ifb0 parent 1: 2>/dev/null | grep -q 'dport 8443'"
else
  check "ifb limitation reported honestly (ifb_v4 != ok)" "! echo \"\$out\" | grep -q 'ifb_v4=ok'"
fi
if [[ "$CL_OK" == 1 ]]; then
  check "per-IP connlimit installed" "iptables -w -S MTPW3 2>/dev/null | grep -q 'connlimit-above 64'"
fi

# idempotency
run 8443 10000 5000 100 64 "" >/dev/null
if [[ "$NFT_CT_OK" == 1 ]]; then
  check "reapply does not duplicate the global rule" "[[ \$(nft list chain inet mtpanel input 2>/dev/null | grep -c 'ct count over') -eq 1 ]]"
fi
# second worker independent
net_input 8444 0 0 50 0 "" | bash "$HELPER" net-apply 4 >/dev/null
if [[ "$NFT_CT_OK" == 1 ]]; then
  check "second worker gets its own independent counter" "[[ \$(nft list chain inet mtpanel input 2>/dev/null | grep -c 'ct count over') -eq 2 ]] && nft list chain inet mtpanel input | grep -q 'ct count over 50'"
fi
# change limit replaces
run 8443 0 0 250 0 "" >/dev/null
if [[ "$NFT_CT_OK" == 1 ]]; then
  check "changing TOTAL replaces the rule (no duplicates)" "nft list chain inet mtpanel input | grep -q 'ct count over 250' && [[ \$(nft list chain inet mtpanel input | grep -c 'mtp-global-3') -eq 1 ]]"
fi
# TOTAL=0 removes
run 8443 0 0 0 0 "" >/dev/null
check "TOTAL=0 removes the worker's global rule" "! nft list chain inet mtpanel input 2>/dev/null | grep -q 'mtp-global-3'"

# remove cleans up
net_input 8443 0 0 100 0 "" | bash "$HELPER" net-apply 3 >/dev/null
out=$(bash "$HELPER" remove 3); rc=$?
check "remove exits 0" "[[ \$rc -eq 0 ]]"
check "remove deletes the worker's nft rule" "! nft list chain inet mtpanel input 2>/dev/null | grep -q 'mtp-global-3'"
if [[ "$TC_OK" == 1 ]]; then
  check "remove deletes tc filters" "! tc filter show dev dummy0 parent 1: 2>/dev/null | grep -q 'sport 8443'"
fi
check "remove reports leftover rule count 0" "echo \"\$out\" | grep -q 'nft_rules_left=0'"

# invalid input rejected without touching the live ruleset
before=$(nft list ruleset 2>/dev/null | sha256sum)
out=$(printf 'PORT=8443\nDOWN=0\nUP=0\nTOTAL=999999999999\nPERIP=0\nBLOCKS=\n' | bash "$HELPER" net-apply 9 2>&1); rc=$?
after=$(nft list ruleset 2>/dev/null | sha256sum)
check "out-of-range TOTAL rejected (non-zero exit)" "[[ \$rc -ne 0 ]]"
check "rejected input leaves the live ruleset untouched" "[[ \"\$before\" == \"\$after\" ]]"

echo
echo "netns integration: pass=$PASS fail=$FAIL"
[[ $FAIL -eq 0 ]]
OUTER
rc=$?
if [[ $rc -eq 3 ]]; then echo "SKIP: namespace unsupported"; fi
exit $rc
