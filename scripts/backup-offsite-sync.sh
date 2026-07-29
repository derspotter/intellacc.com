#!/bin/bash
# Nightly offsite sync of the Intellacc backups to the always-on Mac mini
# (tailnet). Additive on purpose — no --delete, so local wipe/compromise
# cannot cascade to the offsite copies. Remote retention: 30 days.
set -euo pipefail

SRC="/var/opt/docker/backups/intellacc/"
KEY="$HOME/.ssh/id_ed25519_mac-mini-von-val"
DEST="sag@100.111.127.90"
DEST_DIR="backups/intellacc/"

rsync -az -e "ssh -o BatchMode=yes -i $KEY" \
  --include='*.dump' --include='*.tar.gz' --exclude='*' \
  "$SRC" "$DEST:$DEST_DIR"

ssh -o BatchMode=yes -i "$KEY" "$DEST" \
  "find $DEST_DIR -type f \( -name '*.dump' -o -name '*.tar.gz' \) -mtime +30 -delete"

echo "[offsite] $(date +%F) synced: $(ssh -o BatchMode=yes -i "$KEY" "$DEST" "ls $DEST_DIR | wc -l") files remote"
