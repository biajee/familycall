#!/usr/bin/env bash
# Syncs the call server to the shared zbackroom box. .env, node_modules and the
# push-subscription data are excluded, so a sync can never overwrite secrets or
# state. Run from anywhere; then run deploy/deploy.sh on the server.
set -euo pipefail
cd "$(dirname "$0")/.."

rsync -az --delete \
  --exclude node_modules --exclude .env --exclude data --exclude .git \
  --exclude test \
  ./ zbackroom:/var/www/callserver/

echo "==> Synced. Run deploy/deploy.sh on the server next (first time: deploy/setup-zbackroom.sh)."
