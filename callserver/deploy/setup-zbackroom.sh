#!/usr/bin/env bash
# One-time setup of the call server on the shared zbackroom box (call.zbackroom.com),
# next to zbackroom / ConfirmPO / alerty / FamilyCall. Safe to re-run: it keeps an
# existing .env and only refreshes configs. Run ON THE SERVER after deploy/sync.sh:
#   cd /var/www/callserver && bash deploy/setup-zbackroom.sh
#
# Unlike deploy/setup-vps.sh (the dedicated-VPS installer, which brings its own Caddy
# and enables ufw), this uses the box's nginx + certbot and does NOT touch the firewall.
# The AWS security group is the firewall here; see the port list printed at the end.
set -euo pipefail

DOMAIN=call.zbackroom.com
APP_DIR=/var/www/callserver
DATA_DIR=/var/lib/callserver
cd "$APP_DIR"

echo "==> unprivileged user + data directory"
id -u callserver >/dev/null 2>&1 || sudo useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin callserver
sudo install -d -m 750 -o callserver -g callserver "$DATA_DIR"

echo "==> packages"
npm install --omit=dev --no-audit --no-fund
sudo apt-get install -y coturn

echo "==> .env"
if [ ! -f .env ]; then
  SHELL_SECRET="$(grep -E '^FAMILYCALL_INTERNAL_SECRET=' /var/www/familycall/.env | head -1 | cut -d= -f2- | tr -d '"')"
  [ -n "$SHELL_SECRET" ] || { echo "FamilyCall's FAMILYCALL_INTERNAL_SECRET not found in /var/www/familycall/.env"; exit 1; }
  TURN_SECRET="$(openssl rand -hex 32)"
  VAPID="$(node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")"
  umask 027
  cat > .env <<EOF
HOST=127.0.0.1
PORT=3004
LOG_LEVEL=info
DATA_DIR=${DATA_DIR}

# The FamilyCall app checks rooms and receives usage reports (same secret as
# FAMILYCALL_INTERNAL_SECRET in /var/www/familycall/.env).
FAMILYCALL_SHELL_URL=https://familycall.zbackroom.com
FAMILYCALL_INTERNAL_SECRET=${SHELL_SECRET}

# Speech-to-text: add OPENAI_API_KEY (or DEEPGRAM_API_KEY), then restart.
STT_PROVIDER=
OPENAI_API_KEY=
OPENAI_TRANSCRIBE_MODEL=gpt-live-transcribe
OPENAI_TRANSCRIBE_DELAY=low
OPENAI_NOISE_REDUCTION=near_field
STT_PROMPT=A relaxed family video call between relatives, spoken in Mandarin Chinese and English.
STT_IDLE_CLOSE_MS=45000

# WebRTC relay (coturn on this box). TURN also answers STUN.
STUN_URLS=
TURN_URLS=turn:${DOMAIN}:3478?transport=udp,turn:${DOMAIN}:3478?transport=tcp,turns:${DOMAIN}:5349?transport=tcp
TURN_SECRET=${TURN_SECRET}
TURN_TTL=43200

# Web Push (incoming-call notifications)
VAPID_PUBLIC_KEY=${VAPID%% *}
VAPID_PRIVATE_KEY=${VAPID##* }
VAPID_SUBJECT=mailto:contact@zbackroom.com
EOF
  echo "    wrote .env (no STT key yet)"
else
  echo "    keeping existing .env"
fi
# The service runs as `callserver`, which must be able to read it; nobody else can.
sudo chown ubuntu:callserver .env
sudo chmod 640 .env
TURN_SECRET="$(grep -E '^TURN_SECRET=' .env | cut -d= -f2-)"

echo "==> nginx site"
sudo cp deploy/nginx-call.conf /etc/nginx/sites-available/${DOMAIN}
sudo ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
sudo nginx -t
sudo systemctl reload nginx

echo "==> TLS certificate"
sudo certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --redirect

echo "==> hand the certificate to coturn (now, and on every renewal)"
sudo tee /etc/letsencrypt/renewal-hooks/deploy/coturn-call.sh >/dev/null <<HOOK
#!/bin/sh
# Certbot deploy hook: copy the call.zbackroom.com cert to where coturn reads it.
case " \$RENEWED_DOMAINS " in *" ${DOMAIN} "*) ;; *) exit 0 ;; esac
install -d -m 750 -o turnserver -g turnserver /etc/coturn
install -m 640 -o turnserver -g turnserver /etc/letsencrypt/live/${DOMAIN}/fullchain.pem /etc/coturn/cert.pem
install -m 640 -o turnserver -g turnserver /etc/letsencrypt/live/${DOMAIN}/privkey.pem /etc/coturn/key.pem
systemctl restart coturn
HOOK
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/coturn-call.sh
sudo RENEWED_DOMAINS="${DOMAIN}" /etc/letsencrypt/renewal-hooks/deploy/coturn-call.sh || true

echo "==> coturn"
PUBLIC_IP="$(curl -4fsS https://api.ipify.org)"
PRIVATE_IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
EXTERNAL_IP="${PUBLIC_IP}"
[ -n "${PRIVATE_IP}" ] && [ "${PRIVATE_IP}" != "${PUBLIC_IP}" ] && EXTERNAL_IP="${PUBLIC_IP}/${PRIVATE_IP}"
sed -e "s#__EXTERNAL_IP__#${EXTERNAL_IP}#" -e "s#__TURN_SECRET__#${TURN_SECRET}#" \
  deploy/turnserver-zbackroom.conf | sudo tee /etc/turnserver.conf >/dev/null
sudo chmod 640 /etc/turnserver.conf
sudo chgrp turnserver /etc/turnserver.conf
if [ -f /etc/default/coturn ]; then sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn; fi
sudo systemctl enable coturn >/dev/null 2>&1
sudo systemctl restart coturn

echo "==> call server service"
sudo cp deploy/callserver.service /etc/systemd/system/callserver.service
sudo systemctl daemon-reload
sudo systemctl enable callserver >/dev/null 2>&1
sudo systemctl restart callserver

echo
grep -qE '^OPENAI_API_KEY=.+|^DEEPGRAM_API_KEY=.+' .env || echo "!! No speech-to-text key in .env yet: captions will use the fake 'mock' provider until you add one."
echo "Ports that must be open in the AWS security group for calls between different networks:"
echo "  TCP+UDP 3478 (TURN/STUN), TCP 5349 (TURN over TLS), UDP 49152-49951 (relayed media)"
