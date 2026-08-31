#!/usr/bin/env bash
# One-shot installer for Ubuntu 22.04 / 24.04. Run as root on a fresh VPS:
#   DOMAIN=call.example.com bash deploy/setup-vps.sh
# Afterwards edit /opt/stt-videocall/.env (STT key) and: systemctl restart stt-videocall
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN=call.example.com (DNS A record must already point at this VPS)}"
APP_DIR=/opt/stt-videocall
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_IP="$(curl -4fsS https://api.ipify.org || curl -4fsS https://ifconfig.me)"
PRIVATE_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
# Behind 1:1 NAT (AWS/GCP/Azure/...) coturn needs the public/private pair.
EXTERNAL_IP="${PUBLIC_IP}"
if [ -n "${PRIVATE_IP}" ] && [ "${PRIVATE_IP}" != "${PUBLIC_IP}" ]; then
  EXTERNAL_IP="${PUBLIC_IP}/${PRIVATE_IP}"
fi
TURN_SECRET="$(openssl rand -hex 32)"

echo "==> Installing packages"
apt-get update
apt-get install -y curl gnupg debian-keyring debian-archive-keyring apt-transport-https coturn ufw
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "==> Installing app to ${APP_DIR}"
id -u videocall >/dev/null 2>&1 || useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin videocall
mkdir -p "${APP_DIR}"
rsync -a --delete --exclude node_modules --exclude .env --exclude .git "${SRC_DIR}/" "${APP_DIR}/"
(cd "${APP_DIR}" && npm install --omit=dev --no-audit --no-fund)
if [ ! -f "${APP_DIR}/.env" ]; then
  sed -e "s#call.example.com#${DOMAIN}#g" -e "s#^TURN_SECRET=.*#TURN_SECRET=${TURN_SECRET}#" \
    "${APP_DIR}/.env.example" > "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  echo "    wrote ${APP_DIR}/.env (add your OPENAI_API_KEY or DEEPGRAM_API_KEY there)"
else
  TURN_SECRET="$(grep -E '^TURN_SECRET=' "${APP_DIR}/.env" | cut -d= -f2-)"
  echo "    keeping existing ${APP_DIR}/.env"
fi
chown -R videocall:videocall "${APP_DIR}"

echo "==> Caddy (HTTPS for ${DOMAIN})"
sed "s#{\$DOMAIN}#${DOMAIN}#" "${SRC_DIR}/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy

echo "==> coturn"
sed -e "s#__PUBLIC_IP__#${EXTERNAL_IP}#" -e "s#__DOMAIN__#${DOMAIN}#" -e "s#__TURN_SECRET__#${TURN_SECRET}#" \
  "${SRC_DIR}/deploy/turnserver.conf" > /etc/turnserver.conf
if [ -f /etc/default/coturn ]; then sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn; fi
install -m 755 "${SRC_DIR}/deploy/copy-turn-cert.sh" /usr/local/bin/copy-turn-cert.sh
# Wait for Caddy to obtain the certificate, then hand it to coturn (retry for ~2 minutes).
for i in $(seq 1 24); do
  if /usr/local/bin/copy-turn-cert.sh "${DOMAIN}" 2>/dev/null; then break; fi
  sleep 5
done
if [ ! -f /etc/coturn/cert.pem ]; then
  echo "    (no TLS cert yet: turns: will not work until 'copy-turn-cert.sh ${DOMAIN}' succeeds; turn: still works)"
  sed -i -e 's#^cert=#\#cert=#' -e 's#^pkey=#\#pkey=#' /etc/turnserver.conf
fi
cat > /etc/cron.weekly/copy-turn-cert <<CRON
#!/bin/sh
/usr/local/bin/copy-turn-cert.sh ${DOMAIN} >/dev/null 2>&1 || true
CRON
chmod 755 /etc/cron.weekly/copy-turn-cert
systemctl enable --now coturn
systemctl restart coturn

echo "==> systemd service"
install -m 644 "${SRC_DIR}/deploy/stt-videocall.service" /etc/systemd/system/stt-videocall.service
systemctl daemon-reload
systemctl enable --now stt-videocall
systemctl restart stt-videocall

echo "==> Firewall"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 5349/tcp
ufw allow 49152:65535/udp
ufw --force enable

echo
echo "Done. Open https://${DOMAIN}/ on both phones."
echo "Check: curl -s https://${DOMAIN}/healthz ; journalctl -u stt-videocall -f"
