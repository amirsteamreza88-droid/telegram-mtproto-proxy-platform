#!/bin/bash
# MTPanel – one-command installer for Ubuntu 24.04 LTS.
#
#   git clone https://github.com/YOUR_ORG/mtpanel.git && cd mtpanel && sudo bash install.sh
#
# Options (all optional; values are remembered in /etc/mtpanel/install.conf):
#   --domain panel.example.com   use a domain + Let's Encrypt certificate
#   --email you@example.com      ACME account e-mail (domain mode)
#   --panel-port 8443            public HTTPS dashboard port
#   --backend-port 3000          localhost-only backend port
#   --ip-cert auto|letsencrypt|selfsigned   certificate strategy for IP access (default auto)
#   --keep-pid-max               do not lower kernel.pid_max (see docs/TROUBLESHOOTING.md)
#   --no-firewall                do not enable/configure UFW
#
# The script is idempotent: re-running it repairs/updates the installation and never
# regenerates existing secrets, passwords or certificates.
set -euo pipefail
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/lib.sh
. "$SRC_DIR/deploy/lib.sh"

require_root
require_ubuntu_2404

DOMAIN="" EMAIL="" PANEL_PORT=8443 BACKEND_PORT=3000 IP_CERT=auto KEEP_PID_MAX=0 FIREWALL=1
[[ -f "$INSTALL_CONF" ]] && . "$INSTALL_CONF"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN=$2; shift 2 ;;
    --email) EMAIL=$2; shift 2 ;;
    --panel-port) PANEL_PORT=$2; shift 2 ;;
    --backend-port) BACKEND_PORT=$2; shift 2 ;;
    --ip-cert) IP_CERT=$2; shift 2 ;;
    --keep-pid-max) KEEP_PID_MAX=1; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || die "invalid --domain"
[[ "$PANEL_PORT" =~ ^[0-9]+$ && "$BACKEND_PORT" =~ ^[0-9]+$ ]] || die "invalid port"
[[ "$IP_CERT" =~ ^(auto|letsencrypt|selfsigned)$ ]] || die "invalid --ip-cert"
[[ "$PANEL_PORT" != "$BACKEND_PORT" ]] || die "panel and backend port must differ"
(( PANEL_PORT != 443 )) || warn "dashboard on 443 conflicts with the default MTProto port – choose another worker port"

log "Checking port conflicts"
port_in_use_by_other "$PANEL_PORT" 'nginx' && die "TCP $PANEL_PORT is in use by another process: $(ss -Htlnp "sport = :$PANEL_PORT")"
port_in_use_by_other "$BACKEND_PORT" 'node|next' && die "TCP $BACKEND_PORT is in use by another process"
port_in_use_by_other 80 'nginx' && warn "TCP 80 is used by another process – ACME HTTP validation will fail (self-signed fallback)"
port_in_use_by_other 443 'mtproto' && warn "TCP 443 is in use – the default MTProto port will not be available for workers"

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git build-essential libssl-dev zlib1g-dev \
  postgresql postgresql-contrib nginx ufw iproute2 iptables openssl rsync sudo jq certbot cron >/dev/null

if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 20 )); then
  log "Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

log "Creating service accounts"
id mtpanel >/dev/null 2>&1 || useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin mtpanel
id mtproxy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin mtproxy
install -d -o mtpanel -g mtpanel -m 0750 "$PREFIX" "$RELEASES"
install -d -o root -g mtpanel -m 0750 "$ETC"
install -d -o root -g root -m 0700 "$ETC/workers"
install -d -o mtpanel -g mtpanel -m 0750 "$VAR" "$VAR/data" "$VAR/backups"
install -d -o root -g root -m 0700 "$VAR/net"
install -d -m 0755 /var/lib/mtproxy /var/www/mtpanel-acme

log "Building MTProxy (official TelegramMessenger/MTProxy)"
MTPROXY_REPO=${MTPROXY_REPO:-https://github.com/TelegramMessenger/MTProxy.git}
if [[ ! -d /opt/mtproxy/src/.git ]]; then
  git clone -q "$MTPROXY_REPO" /opt/mtproxy/src
else
  git -C /opt/mtproxy/src fetch -q && git -C /opt/mtproxy/src reset -q --hard origin/HEAD
fi
rev=$(git -C /opt/mtproxy/src rev-parse HEAD)
if [[ ! -x /opt/mtproxy/mtproto-proxy || "$(cat /opt/mtproxy/.rev 2>/dev/null)" != "$rev" ]]; then
  ( cd /opt/mtproxy/src
    make clean >/dev/null 2>&1 || true
    # GCC >= 10 defaults to -fno-common which breaks the upstream build
    sed -i 's/^CFLAGS = /CFLAGS = -fcommon /' Makefile
    make -j"$(nproc)" >/dev/null
    git checkout -q Makefile )
  install -m 0755 /opt/mtproxy/src/objs/bin/mtproto-proxy /opt/mtproxy/mtproto-proxy
  echo "$rev" > /opt/mtproxy/.rev
fi

if [[ "$KEEP_PID_MAX" != 1 ]]; then
  # Official MTProxy asserts on PIDs > 65535 (Ubuntu 24.04 default pid_max is 4194304).
  echo "kernel.pid_max = 65535" > /etc/sysctl.d/99-mtpanel.conf
  sysctl -q -p /etc/sysctl.d/99-mtpanel.conf || warn "could not apply kernel.pid_max"
fi

log "Installing host helper, systemd units and sudoers rule"
install_host_components "$SRC_DIR"
/usr/local/lib/mtpanel/update-telegram-config.sh || die "could not download Telegram proxy configuration"
PUB_IP=$(public_ip || true)
[[ -n "$PUB_IP" ]] && echo "$PUB_IP" > "$ETC/public_ip" && chmod 0644 "$ETC/public_ip"

log "Configuring PostgreSQL (local access only)"
systemctl enable --now postgresql >/dev/null
PGCONF=$(sudo -u postgres psql -tAc "SHOW config_file")
if ! grep -Eq "^\s*listen_addresses\s*=\s*'localhost'" "$PGCONF"; then
  sed -i "s/^#\?\s*listen_addresses\s*=.*/listen_addresses = 'localhost'/" "$PGCONF"
  systemctl restart postgresql
fi
DB_PASS=$(env_get DB_PASS)
[[ -n "$DB_PASS" ]] || DB_PASS=$(openssl rand -hex 24)
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='mtpanel'" | grep -q 1; then
  sudo -u postgres psql -qc "ALTER ROLE mtpanel WITH LOGIN PASSWORD '$DB_PASS'"
else
  sudo -u postgres psql -qc "CREATE ROLE mtpanel WITH LOGIN PASSWORD '$DB_PASS'"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='mtpanel'" | grep -q 1 || sudo -u postgres createdb -O mtpanel mtpanel

log "Writing panel configuration"
APP_SECRET_KEY=$(env_get APP_SECRET_KEY)
[[ -n "$APP_SECRET_KEY" ]] || APP_SECRET_KEY=$(openssl rand -hex 32)
umask 027
cat > "$PANEL_ENV" <<EOF
# MTPanel runtime configuration – keep APP_SECRET_KEY safe: it encrypts secrets & backups
NODE_ENV=production
PORT=$BACKEND_PORT
DATABASE_URL=postgresql://mtpanel:$DB_PASS@127.0.0.1:5432/mtpanel
DB_PASS=$DB_PASS
DB_NAME=mtpanel
APP_SECRET_KEY=$APP_SECRET_KEY
COOKIE_SECURE=true
DATA_DIR=$VAR/data
BACKUP_DIR=$VAR/backups
HOST_HELPER=/usr/local/sbin/mtpanel-helper
PANEL_PUBLIC_PORT=$PANEL_PORT
NEXT_TELEMETRY_DISABLED=1
EOF
chown root:mtpanel "$PANEL_ENV"; chmod 0640 "$PANEL_ENV"
umask 022
cat > "$INSTALL_CONF" <<EOF
DOMAIN="$DOMAIN"
EMAIL="$EMAIL"
PANEL_PORT=$PANEL_PORT
BACKEND_PORT=$BACKEND_PORT
IP_CERT=$IP_CERT
KEEP_PID_MAX=$KEEP_PID_MAX
FIREWALL=$FIREWALL
SOURCE_DIR="$SRC_DIR"
EOF

log "Building and deploying the application"

REL=$(build_release "$SRC_DIR") || die "Application build failed. Installation aborted."
migrate_release "$REL" || die "Database migration failed. Installation aborted."
activate_release "$REL" || die "Failed to activate application release."
prune_releases


log "Configuring HTTPS"
SSL_DIR=$ETC/ssl; install -d -m 0750 "$SSL_DIR"
SERVER_NAME=${DOMAIN:-_}
render_nginx() {
  sed -e "s|__SERVER_NAME__|$SERVER_NAME|g" -e "s|__PANEL_PORT__|$PANEL_PORT|g" -e "s|__BACKEND_PORT__|$BACKEND_PORT|g" \
      -e "s|__CERT__|$1|g" -e "s|__KEY__|$2|g" "$SRC_DIR/deploy/nginx/mtpanel.conf.tmpl" > /etc/nginx/sites-available/mtpanel.conf
  ln -sfn /etc/nginx/sites-available/mtpanel.conf /etc/nginx/sites-enabled/mtpanel.conf
  rm -f /etc/nginx/sites-enabled/default
  nginx -t -q && systemctl reload-or-restart nginx
}
selfsigned() {
  if [[ ! -s "$SSL_DIR/selfsigned.crt" ]]; then
    local cn=${DOMAIN:-${PUB_IP:-mtpanel}}
    local san="DNS:localhost"; [[ -n "$PUB_IP" ]] && san="$san,IP:$PUB_IP"; [[ -n "$DOMAIN" ]] && san="$san,DNS:$DOMAIN"
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 -subj "/CN=$cn" -addext "subjectAltName=$san" \
      -keyout "$SSL_DIR/selfsigned.key" -out "$SSL_DIR/selfsigned.crt" 2>/dev/null
    chmod 0600 "$SSL_DIR/selfsigned.key"
  fi
  CERT_KIND="self-signed (NOT publicly trusted – your browser will warn)"
  render_nginx "$SSL_DIR/selfsigned.crt" "$SSL_DIR/selfsigned.key"
}
# start with a self-signed cert so nginx can serve ACME challenges on :80
selfsigned
if [[ "$FIREWALL" == 1 ]]; then ufw allow 80/tcp >/dev/null 2>&1 || true; fi
if [[ -n "$DOMAIN" ]]; then
  if [[ -n "$EMAIL" ]]; then ACME_MAIL=(-m "$EMAIL"); else ACME_MAIL=(--register-unsafely-without-email); fi
  if certbot certonly --webroot -w /var/www/mtpanel-acme -d "$DOMAIN" --non-interactive --agree-tos \
       "${ACME_MAIL[@]}" --keep-until-expiring \
       --deploy-hook "systemctl reload nginx" >/dev/null 2>&1; then
    render_nginx "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "/etc/letsencrypt/live/$DOMAIN/privkey.pem"
    CERT_KIND="Let's Encrypt (auto-renewed by certbot.timer)"
    systemctl enable --now certbot.timer >/dev/null 2>&1 || true
  else
    warn "Let's Encrypt issuance for $DOMAIN failed (DNS must point to this server and port 80 must be reachable). Using self-signed."
  fi
elif [[ "$IP_CERT" != selfsigned && -n "$PUB_IP" ]]; then
  ACME=/root/.acme.sh/acme.sh
  [[ -x "$ACME" ]] || curl -fsSL https://get.acme.sh | sh -s email="${EMAIL:-admin@$PUB_IP.invalid}" >/dev/null 2>&1 || true
  if [[ -x "$ACME" ]] && "$ACME" --issue --server letsencrypt -d "$PUB_IP" -w /var/www/mtpanel-acme \
        --certificate-profile shortlived --days 3 >/dev/null 2>&1 || [[ -s "/root/.acme.sh/${PUB_IP}_ecc/fullchain.cer" ]]; then
    "$ACME" --install-cert -d "$PUB_IP" --key-file "$SSL_DIR/ip.key" --fullchain-file "$SSL_DIR/ip.crt" \
      --reloadcmd "systemctl reload nginx" >/dev/null 2>&1
    render_nginx "$SSL_DIR/ip.crt" "$SSL_DIR/ip.key"
    CERT_KIND="Let's Encrypt IP certificate (6-day shortlived profile, renewed by acme.sh cron)"
  else
    [[ "$IP_CERT" == letsencrypt ]] && warn "Let's Encrypt IP certificate could not be issued."
    warn "Using a self-signed certificate for IP access."
  fi
fi

if [[ "$FIREWALL" == 1 ]]; then
  log "Configuring UFW firewall"
  for p in $(sshd -T 2>/dev/null | awk '/^port /{print $2}'); do ufw allow "$p/tcp" comment ssh >/dev/null; done
  ufw allow 22/tcp comment ssh >/dev/null 2>&1 || true
  ufw allow "$PANEL_PORT/tcp" comment mtpanel-dashboard >/dev/null
  ufw deny "$BACKEND_PORT/tcp" >/dev/null 2>&1 || true
  ufw deny 5432/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null
fi

log "Starting services"
systemctl enable --now mtproxy-config-update.timer >/dev/null
systemctl enable mtpanel-netrules.service >/dev/null
systemctl restart mtpanel-netrules.service || warn "network rules restore reported errors"
systemctl enable mtpanel.service >/dev/null
systemctl restart mtpanel.service
health_wait "$BACKEND_PORT" 60 || { journalctl -u mtpanel -n 50 --no-pager; die "panel failed its health check"; }

ADMIN_MSG="(existing administrator kept)"
ADMIN_PW=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
res=$(printf '%s' "$ADMIN_PW" | sudo -u mtpanel -H bash -c "set -a; . '$PANEL_ENV'; set +a; cd '$CURRENT' && node scripts/create-admin.mjs --username admin --if-none")
if [[ "$res" == CREATED ]]; then
  ADMIN_MSG="username: ${c_bold}admin${c_off}   password: ${c_bold}$ADMIN_PW${c_off}   (shown once – change it in Settings)"
fi
unset ADMIN_PW

if curl -fsSk --max-time 5 "https://127.0.0.1:$PANEL_PORT/api/health" >/dev/null; then HTTPS_OK=yes; else HTTPS_OK=no; fi

echo
echo "${c_bold}MTPanel installation complete${c_off}"
echo "-------------------------------------------------------------"
[[ -n "$DOMAIN" ]] && echo "  Dashboard (domain): https://$DOMAIN:$PANEL_PORT"
[[ -n "$PUB_IP" ]] && echo "  Dashboard (IP):     https://$PUB_IP:$PANEL_PORT"
echo "  Certificate:        ${CERT_KIND}"
echo "  HTTPS self-test:    $HTTPS_OK"
echo "  Administrator:      $ADMIN_MSG"
echo "  Backend:            127.0.0.1:$BACKEND_PORT (not exposed)   PostgreSQL: localhost only"
echo "  Secrets:            $PANEL_ENV  (back up APP_SECRET_KEY securely!)"
echo "  Diagnostics:        sudo bash $SRC_DIR/deploy/doctor.sh"
echo "-------------------------------------------------------------"
