#!/bin/bash
# Scheduled daily at 09:00 Europe/Berlin by the host crontab.
set -euo pipefail
exec /usr/bin/flock -n /tmp/intellacc-market-question-digest.lock \
  /usr/bin/docker exec intellacc_backend node \
  /usr/src/app/src/services/marketQuestionDigest.js "${1:?recipient required}" "${@:2}"
