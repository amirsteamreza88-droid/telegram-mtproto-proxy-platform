#!/bin/bash
# Restore a system backup created by deploy/backup.sh (also works on a fresh server
# after running install.sh).  sudo bash deploy/restore.sh /path/mtpanel-system-*.tar.gz.enc
set -euo pipefail
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "$SRC_DIR/deploy/lib.sh"
require_root
FILE=${1:-}; [[ -f "$FILE" ]] || die "usage: restore.sh <backup-file>"
[[ -f "$PANEL_ENV" ]] || die "run install.sh first"
if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then read -rsp "Backup passphrase: " BACKUP_PASSPHRASE; echo; fi
export BACKUP_PASSPHRASE
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" | tar -C "$WORK" -xzf - || die "wrong passphrase or corrupted file"
( cd "$WORK" && sha256sum -c --quiet SHA256SUMS ) || die "checksum validation failed"
grep -q '^mtpanel-system-backup v1' "$WORK/MANIFEST" || die "not an MTPanel system backup"
read -rp "This replaces the current database and configuration. Type RESTORE to continue: " ans
[[ "$ans" == RESTORE ]] || die "aborted"

log "Creating safety snapshot of current state"
load_panel_env
TS=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump_to "$VAR/backups/pre-restore-$TS.dump"
tar -C / -czf "$VAR/backups/etc-pre-restore-$TS.tgz" etc/mtpanel

log "Stopping services"
systemctl stop mtpanel
for u in $(systemctl list-units --plain --no-legend 'mtproxy@*' | awk '{print $1}'); do systemctl stop "$u" || true; done

log "Restoring configuration"
tar -C / -xf "$WORK/etc.tar"
load_panel_env
# DB password in restored panel.env must match the role
sudo -u postgres psql -qc "ALTER ROLE mtpanel WITH LOGIN PASSWORD '$DB_PASS'"
log "Restoring database"
sudo -u postgres pg_restore --clean --if-exists --no-owner --role=mtpanel -d "$DB_NAME" "$WORK/db.dump" || warn "pg_restore reported warnings"
sudo -u postgres psql -d "$DB_NAME" -qc "DELETE FROM sessions" || true

log "Restarting services"
systemctl daemon-reload
systemctl restart mtpanel-netrules
for f in /etc/mtpanel/workers/*.env; do
  [[ -e "$f" ]] || continue
  id=$(basename "$f" .env)
  if [[ "$(sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT desired_state FROM workers WHERE id=$id" 2>/dev/null)" == running ]]; then
    systemctl enable --now "mtproxy@$id.service" || warn "worker $id failed to start"
  fi
done
systemctl start mtpanel
health_wait "$PORT" 60 || die "panel failed health check after restore"
log "Restore complete. Use Settings → Re-sync host in the dashboard to re-verify every worker."
