#!/bin/bash
# Shared functions for install.sh / update.sh / backup.sh / restore.sh / uninstall.sh
set -euo pipefail

PREFIX=/opt/mtpanel
RELEASES=$PREFIX/releases
CURRENT=$PREFIX/current
ETC=/etc/mtpanel
VAR=/var/lib/mtpanel
PANEL_ENV=$ETC/panel.env
INSTALL_CONF=$ETC/install.conf
NODE_MAJOR=22

c_green=$'\e[32m'; c_red=$'\e[31m'; c_yellow=$'\e[33m'; c_bold=$'\e[1m'; c_off=$'\e[0m'
log()  { echo "${c_green}==>${c_off} $*"; }
warn() { echo "${c_yellow}WARN:${c_off} $*" >&2; }
die()  { echo "${c_red}ERROR:${c_off} $*" >&2; exit 1; }

require_root() { [[ $EUID -eq 0 ]] || die "run as root (sudo bash $0)"; }

require_ubuntu_2404() {
  [[ -f /etc/os-release ]] || die "cannot detect OS"
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
    [[ "${MTPANEL_ALLOW_UNSUPPORTED:-0}" == 1 ]] || die "Ubuntu 24.04 LTS is required (found ${PRETTY_NAME:-unknown}). Set MTPANEL_ALLOW_UNSUPPORTED=1 to override at your own risk."
    warn "unsupported OS ${PRETTY_NAME:-unknown} – continuing because MTPANEL_ALLOW_UNSUPPORTED=1"
  fi
  [[ -d /run/systemd/system ]] || die "systemd is required"
  [[ -f /sys/fs/cgroup/cgroup.controllers ]] || die "cgroup v2 (unified hierarchy) is required for per-worker accounting"
}

env_get() { [[ -f "$PANEL_ENV" ]] && sed -n "s/^$1=//p" "$PANEL_ENV" | head -1 || true; }

load_panel_env() {
  set -a
  # shellcheck disable=SC1090
  . "$PANEL_ENV"
  set +a
}

port_in_use_by_other() {
  # $1 port, $2 allowed process name regex
  local line; line=$(ss -Htlnp "sport = :$1" 2>/dev/null || true)
  [[ -z "$line" ]] && return 1
  [[ -n "${2:-}" ]] && echo "$line" | grep -Eq "$2" && return 1
  return 0
}

public_ip() {
  local ip
  for u in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
    ip=$(curl -4fsS --max-time 6 "$u" 2>/dev/null | tr -d '[:space:]') || true
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && { echo "$ip"; return 0; }
  done
  return 1
}

health_wait() {
  local port=$1 tries=${2:-60}
  for _ in $(seq 1 "$tries"); do
    curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}


# Build a new release from the source directory $1 as the mtpanel user.
# Echoes the release directory path on success.
build_release() {
  local src=$1 ts rel

  ts=$(date -u +%Y%m%d%H%M%S)
  rel=$RELEASES/$ts

  mkdir -p "$rel"

  if ! rsync -a --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude .next \
    --exclude .data \
    --exclude .env \
    "$src"/ "$rel"/; then
    rm -rf "$rel"
    die "Failed to copy application source into release."
  fi

  chown -R mtpanel:mtpanel "$rel"

  log "Installing npm dependencies (release $ts)" >&2

  if ! sudo -u mtpanel -H bash -c \
  "cd '$rel' && npm ci --no-audit --no-fund --loglevel=error" >&2; then
    rm -rf "$rel"
    die "npm ci failed. Release was not created."
  fi

  log "Building application" >&2

 if ! sudo -u mtpanel -H bash -c \
  "set -a; . '$PANEL_ENV'; set +a; cd '$rel' && MTP_DISABLE_RUNTIME=1 npm run build" >&2; then
    rm -rf "$rel"
    die "Application build failed. Release was not created."
  fi

  echo "$rel"
}


migrate_release() {
  local rel=$1
  log "Applying database schema (drizzle-kit push)"
  sudo -u mtpanel -H bash -c "set -a; . '$PANEL_ENV'; set +a; cd '$rel' && npx drizzle-kit push --config=deploy/drizzle.config.ts --force"
}

activate_release() {
  ln -sfn "$1" "$CURRENT.new" && mv -Tf "$CURRENT.new" "$CURRENT"
}

prune_releases() {
  local keep=3
  # shellcheck disable=SC2012
  ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((keep + 1)) | while read -r d; do
    [[ "$(readlink -f "$CURRENT")/" == "$d" ]] || rm -rf "$d"
  done
}

pg_dump_to() {
  local out=$1
  load_panel_env
  sudo -u postgres pg_dump -Fc "${DB_NAME:-mtpanel}" > "$out"
}

install_host_components() {
  local src=$1
  install -d -m 0755 /usr/local/lib/mtpanel
  install -o root -g root -m 0755 "$src/deploy/mtpanel-helper" /usr/local/sbin/mtpanel-helper
  install -o root -g root -m 0755 "$src/deploy/run-worker.sh" /usr/local/lib/mtpanel/run-worker.sh
  install -o root -g root -m 0755 "$src/deploy/update-telegram-config.sh" /usr/local/lib/mtpanel/update-telegram-config.sh
  for u in mtproxy@.service mtpanel.service mtpanel-netrules.service mtproxy-config-update.service mtproxy-config-update.timer; do
    install -o root -g root -m 0644 "$src/deploy/systemd/$u" "/etc/systemd/system/$u"
  done
  local sudoers=/etc/sudoers.d/mtpanel tmp
  tmp=$(mktemp)
  cat > "$tmp" <<'EOS'
# MTPanel: the panel service account may run ONLY the validated host helper as root.
Defaults:mtpanel !requiretty
mtpanel ALL=(root) NOPASSWD: /usr/local/sbin/mtpanel-helper
EOS
  visudo -cf "$tmp" >/dev/null || die "generated sudoers file is invalid"
  install -o root -g root -m 0440 "$tmp" "$sudoers"
  rm -f "$tmp"
  systemctl daemon-reload
}
