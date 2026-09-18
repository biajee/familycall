#!/usr/bin/env bash
# Copies the certificate Caddy obtained for $DOMAIN into /etc/coturn so `turns:` (TLS) works.
# Run from cron/systemd timer (weekly) so renewals propagate. Usage: copy-turn-cert.sh call.example.com
set -euo pipefail
DOMAIN="${1:?domain}"
SRC="/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${DOMAIN}"
if [ ! -f "${SRC}/${DOMAIN}.crt" ]; then
  echo "certificate for ${DOMAIN} not found under ${SRC} (has Caddy issued it yet?)" >&2
  exit 1
fi
install -d -m 750 -o turnserver -g turnserver /etc/coturn
install -m 640 -o turnserver -g turnserver "${SRC}/${DOMAIN}.crt" /etc/coturn/cert.pem
install -m 640 -o turnserver -g turnserver "${SRC}/${DOMAIN}.key" /etc/coturn/key.pem
systemctl restart coturn
echo "coturn certificate updated"
