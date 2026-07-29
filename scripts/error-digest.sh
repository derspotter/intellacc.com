#!/bin/bash
# Daily error digest for the self-hosted error tracking (no external SaaS).
# Two sources:
#   1. client_errors table — browser errors reported via POST /api/errors
#   2. backend container logs — server-side error signatures from the last day
# Mails kontakt@intellacc.com via the local inbound postfix when there is
# anything to report (silence means a clean day), then prunes client_errors
# rows older than 30 days.
set -euo pipefail

FRONTEND=$(docker exec intellacc_db psql -U intellacc_user -d intellaccdb -At -F' | ' -c "
SELECT COUNT(*),
       LEFT(message, 160),
       COUNT(DISTINCT COALESCE(user_id, -1)),
       MAX(LEFT(url, 90))
FROM client_errors
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY LEFT(message, 160)
ORDER BY COUNT(*) DESC
LIMIT 20;")

# Deduped error signatures from the backend log. Timestamps and ids vary per
# occurrence, so strip leading noise before counting.
BACKEND=$(docker logs --since 24h intellacc_backend 2>&1 \
  | grep -aE "Error|error:|failed|FATAL" \
  | grep -avE "GET /|POST /|PUT /|DELETE /|jest|deprecat" \
  | cut -c1-160 \
  | sort | uniq -c | sort -rn | head -20 || true)

if [ -z "$FRONTEND" ] && [ -z "$BACKEND" ]; then
  docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c \
    "DELETE FROM client_errors WHERE created_at < NOW() - INTERVAL '30 days';" > /dev/null
  echo "[error-digest] $(date +%F) clean day, no mail"
  exit 0
fi

FE_COUNT=$(docker exec intellacc_db psql -U intellacc_user -d intellaccdb -At -c \
  "SELECT COUNT(*) FROM client_errors WHERE created_at >= NOW() - INTERVAL '24 hours';")

{
  printf 'From: error-digest@intellacc.com\r\n'
  printf 'To: kontakt@intellacc.com\r\n'
  printf 'Subject: [intellacc] error digest: %s frontend error(s) in 24h\r\n' "${FE_COUNT:-0}"
  printf '\r\n'
  if [ -n "$FRONTEND" ]; then
    printf 'FRONTEND (count | message | distinct users | sample url):\r\n\r\n'
    printf '%s\r\n' "$FRONTEND"
  else
    printf 'FRONTEND: none\r\n'
  fi
  printf '\r\n'
  if [ -n "$BACKEND" ]; then
    printf 'BACKEND LOG SIGNATURES (count, first 160 chars):\r\n\r\n'
    printf '%s\r\n' "$BACKEND"
  else
    printf 'BACKEND: none\r\n'
  fi
  printf '\r\nDetails: SELECT * FROM client_errors WHERE created_at >= NOW() - INTERVAL '"'"'24 hours'"'"' ORDER BY created_at DESC;\r\n'
} | curl -s --url smtp://127.0.0.1:25 \
      --mail-from error-digest@intellacc.com \
      --mail-rcpt kontakt@intellacc.com \
      --upload-file -

docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c \
  "DELETE FROM client_errors WHERE created_at < NOW() - INTERVAL '30 days';" > /dev/null

echo "[error-digest] $(date +%F) mailed digest (${FE_COUNT:-0} frontend errors)"
