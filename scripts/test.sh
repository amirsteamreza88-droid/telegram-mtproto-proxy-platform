#!/bin/bash
# Full local test suite. Skipped tests are reported as SKIP and are NEVER counted
# as passed. Exit 0 only if nothing failed.
set -uo pipefail
cd "$(dirname "$0")/.."
PASS=0; FAIL=0; SKIP=0
run() { # <name> <cmd...>   (exit 3 from the command means SKIP)
  local name=$1; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [[ $rc -eq 0 ]]; then echo "PASS  $name"; PASS=$((PASS+1))
  elif [[ $rc -eq 3 ]]; then echo "SKIP  $name"; echo "$out" | tail -3 | sed 's/^/        /'; SKIP=$((SKIP+1))
  else echo "FAIL  $name"; echo "$out" | tail -25 | sed 's/^/        /'; FAIL=$((FAIL+1)); fi
}

echo "== 1. unit tests (node:test) =="
run "unit tests: mtproto + protection engine" node --experimental-strip-types --no-warnings --test tests/*.test.ts

echo "== 2. helper command-generation tests (mocked nft/tc/iptables) =="
run "helper-net tests" bash tests/helper-net.test.sh

echo "== 3. network namespace integration test (real nft/tc) =="
run "netns integration test" bash tests/netns-integration.sh

echo "== 4. shell syntax checks =="
syn=0
for f in install.sh deploy/*.sh deploy/mtpanel-helper scripts/*.sh tests/*.sh; do
  bash -n "$f" || { echo "FAIL  syntax: $f"; syn=1; FAIL=$((FAIL+1)); }
done
[[ $syn -eq 0 ]] && { echo "PASS  syntax: all shell scripts"; PASS=$((PASS+1)); }

if command -v shellcheck >/dev/null 2>&1; then
  run "shellcheck (warning level)" shellcheck -S warning install.sh deploy/*.sh deploy/mtpanel-helper scripts/*.sh
else
  echo "SKIP  shellcheck not installed"
  SKIP=$((SKIP+1))
fi

echo
echo "RESULT: pass=$PASS fail=$FAIL skip=$SKIP   (skips are not passes)"
[[ $FAIL -eq 0 ]]
