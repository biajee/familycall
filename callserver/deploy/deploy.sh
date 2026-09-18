#!/usr/bin/env bash
# Routine update on the server (after deploy/sync.sh): install dependencies, restart, check.
set -euo pipefail
cd /var/www/callserver

echo "==> Installing dependencies"
npm install --omit=dev --no-audit --no-fund

echo "==> Restarting"
sudo systemctl restart callserver
sleep 2
sudo systemctl is-active callserver
curl -fsS http://127.0.0.1:3004/healthz
echo
echo "==> Deploy complete"
