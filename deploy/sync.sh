#!/usr/bin/env bash
# Syncs local code to the server. *.db is excluded by wildcard, not a
# specific filename — see zbackroom's deploy/sync.sh for why that
# distinction matters (a literal-filename exclude there once let rsync
# --delete wipe out a production database).
set -euo pipefail
cd "$(dirname "$0")/.."

rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude .env \
  --exclude 'prisma/*.db' --exclude 'prisma/*.db-journal' \
  --exclude tsconfig.tsbuildinfo \
  ./ zbackroom:/var/www/familycall/

echo "==> Synced. Run deploy/deploy.sh on the server next."
