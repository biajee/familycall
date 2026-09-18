#!/usr/bin/env bash
# Syncs local code to the server. *.db is excluded by wildcard, not a
# specific filename — see zbackroom's deploy/sync.sh for why that
# distinction matters (a literal-filename exclude there once let rsync
# --delete wipe out a production database).
set -euo pipefail
cd "$(dirname "$0")/.."

# callserver/ is the call engine, deployed to its own VPS by its own steps
# (see callserver/README.md) — it doesn't belong on this box.
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude .env \
  --exclude /callserver \
  --exclude 'prisma/*.db' --exclude 'prisma/*.db-journal' \
  --exclude tsconfig.tsbuildinfo \
  ./ zbackroom:/var/www/familycall/

echo "==> Synced. Run deploy/deploy.sh on the server next."
