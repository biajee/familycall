#!/usr/bin/env bash
# Daily SQLite backup, retained for 7 days. Triggered by familycall-backup.timer.
set -euo pipefail

DB=/var/www/familycall/prisma/familycall.db
BACKUP_DIR=/var/backups/familycall
STAMP=$(date +%Y-%m-%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

# Python's sqlite3 module exposes the same online-backup API as the sqlite3
# CLI's `.backup` command (safe against a database being written to), so
# this avoids depending on the sqlite3 CLI package being installed.
python3 - "$DB" "$BACKUP_DIR/familycall_$STAMP.db" <<'EOF'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()
EOF

find "$BACKUP_DIR" -name 'familycall_*.db' -mtime +7 -delete
