#!/bin/bash
# Update MTPanel from the git checkout with automatic rollback.
#   sudo bash deploy/update.sh            (pulls the latest code first)
#   sudo bash deploy/update.sh --no-pull  (deploy the working tree as-is)
set -euo pipefail
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "$SRC_DIR/deploy/lib.sh"
require_root
[[ -f "$PANEL_ENV" ]] || die "MTPanel is not installed – run install.sh"
. "$INSTALL_CONF"
load_panel_env

if [[ "${1:-}" != "--no-pull" && -d "$SRC_DIR/.git" ]]; then
  log "Pulling latest code"
  git -C "$SRC_DIR" pull --ff-only
fi

PREV=$(readlink -f "$CURRENT")
TS=$(date -u +%Y%m%dT%H%M%SZ)
SNAP=$VAR/backups/pre-update-$TS.dump
log "Pre-update database snapshot: $SNAP"
pg_dump_to "$SNAP"; chmod 600 "$SNAP"; chown mtpanel:mtpanel "$SNAP"
cp -a "$ETC" "$VAR/backups/etc-pre-update-$TS"

rollback() {
  warn "Update failed – rolling back to $PREV"
  sudo -u postgres pg_restore --clean --if-exists -d "$DB_NAME" "$SNAP" >/dev/null 2>&1 || warn "database restore reported warnings"
  activate_release "$PREV"
  install_host_components "$PREV"
  systemctl restart mtpanel
  health_wait "$PORT" 30 && log "Rollback successful – previous version running" || die "rollback health check failed – see journalctl -u mtpanel"
  exit 1
}
trap rollback ERR

REL=$(build_release "$SRC_DIR")
migrate_release "$REL"
install_host_components "$SRC_DIR"
activate_release "$REL"
systemctl restart mtpanel-netrules.service
systemctl restart mtpanel
health_wait "$PORT" 60 || false
trap - ERR
prune_releases
log "Update complete ($(basename "$REL"))."
