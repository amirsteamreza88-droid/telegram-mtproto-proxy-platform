#!/bin/bash
# Full system backup: PostgreSQL dump + /etc/mtpanel (workers, keys, TLS), encrypted
# with AES-256 (openssl, PBKDF2). The passphrase is asked interactively or read from
# BACKUP_PASSPHRASE. Store it separately from the backup!
#   sudo bash deploy/backup.sh [output-dir]
set -euo pipefail
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
. "$SRC_DIR/deploy/lib.sh"
require_root
load_panel_env
OUT_DIR=${1:-$VAR/backups}
mkdir -p "$OUT_DIR"
if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
  read -rsp "Backup passphrase: " BACKUP_PASSPHRASE; echo
  read -rsp "Repeat passphrase: " p2; echo
  [[ "$BACKUP_PASSPHRASE" == "$p2" ]] || die "passphrases differ"
fi
[[ ${#BACKUP_PASSPHRASE} -ge 12 ]] || die "passphrase must be at least 12 characters"
export BACKUP_PASSPHRASE
TS=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
log "Dumping database"
sudo -u postgres pg_dump -Fc "$DB_NAME" > "$WORK/db.dump"
log "Archiving configuration"
tar -C / -cf "$WORK/etc.tar" etc/mtpanel var/lib/mtpanel/net 2>/dev/null || tar -C / -cf "$WORK/etc.tar" etc/mtpanel
echo "mtpanel-system-backup v1 $TS $(cat /opt/mtproxy/.rev 2>/dev/null)" > "$WORK/MANIFEST"
( cd "$WORK" && sha256sum db.dump etc.tar > SHA256SUMS )
OUT="$OUT_DIR/mtpanel-system-$TS.tar.gz.enc"
tar -C "$WORK" -czf - MANIFEST SHA256SUMS db.dump etc.tar | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$OUT"
chmod 600 "$OUT"
log "Verifying backup"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$OUT" | tar -tzf - >/dev/null || die "verification failed"
log "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
