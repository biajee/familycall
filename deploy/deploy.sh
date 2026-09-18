#!/usr/bin/env bash
# Zero(-ish)-downtime deploy: build into a fresh .next while the live
# service keeps serving the old one via already-open file handles, then
# swap in with a quick restart instead of stop -> rebuild -> start.
set -euo pipefail
cd /var/www/familycall

echo "==> Installing dependencies"
npm install

echo "==> Applying schema migration"
npx prisma db push

echo "==> Building new version (site stays up during this)"
rm -rf .next-old
[ -d .next ] && mv .next .next-old

npm run build

echo "==> Restarting service on the new build"
sudo systemctl restart familycall
sleep 2
sudo systemctl is-active familycall

rm -rf .next-old
echo "==> Deploy complete"
