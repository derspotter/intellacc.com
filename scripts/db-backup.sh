#!/bin/bash
# Daily backup of the Intellacc production database and uploads.
#
# - pg_dump custom format (compressed, restorable with pg_restore)
# - uploads/ tarball (avatars, post images, message attachments)
# - 14-day retention
#
# Installed in the host crontab (crontab -l). Restore:
#   docker exec -i intellacc_db pg_restore -U intellacc_user -d intellaccdb --clean --if-exists < <dump>
#   tar -xzf uploads-<date>.tar.gz -C /var/opt/docker/intellacc.com/backend
set -euo pipefail

BACKUP_DIR="/var/opt/docker/backups/intellacc"
UPLOADS_DIR="/var/opt/docker/intellacc.com/backend/uploads"
STAMP="$(date +%Y-%m-%d_%H%M)"
RETENTION_DAYS=14

mkdir -p "$BACKUP_DIR"

docker exec intellacc_db pg_dump -U intellacc_user -d intellaccdb -Fc \
  > "$BACKUP_DIR/db-$STAMP.dump.tmp"
mv "$BACKUP_DIR/db-$STAMP.dump.tmp" "$BACKUP_DIR/db-$STAMP.dump"

tar -czf "$BACKUP_DIR/uploads-$STAMP.tar.gz.tmp" -C "$(dirname "$UPLOADS_DIR")" uploads
mv "$BACKUP_DIR/uploads-$STAMP.tar.gz.tmp" "$BACKUP_DIR/uploads-$STAMP.tar.gz"

find "$BACKUP_DIR" -name '*.dump' -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name '*.tar.gz' -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name '*.tmp' -mtime +1 -delete

echo "[db-backup] $STAMP ok: $(du -sh "$BACKUP_DIR" | cut -f1) total in $BACKUP_DIR"
