#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

BASE_URL="${E2E_BASE_URL:-${BASE_URL:-http://localhost:3000}}"
EMAIL="${SMOKE_EMAIL:-}"
PASSWORD="${SMOKE_PASSWORD:-}"
TOKEN="${SMOKE_TOKEN:-}"
EVENT_ID="${SMOKE_EVENT_ID:-}"
TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-30}"
EXPECT_MIN_MATCHES="${SMOKE_EXPECT_MIN_MATCHES:-1}"
POST_CONTENT="${SMOKE_POST_CONTENT:-}"

if [[ -z "${TOKEN}" && ( -z "${EMAIL}" || -z "${PASSWORD}" ) ]]; then
  echo "Set SMOKE_TOKEN or both SMOKE_EMAIL and SMOKE_PASSWORD" >&2
  exit 1
fi

echo "[smoke] base=${BASE_URL}"
if [[ -z "${TOKEN}" ]]; then
  echo "[smoke] logging in as ${EMAIL}"
  LOGIN_PAYLOAD="$(jq -cn --arg email "${EMAIL}" --arg password "${PASSWORD}" '{email:$email,password:$password}')"
  LOGIN_JSON="$(curl -fsS -X POST "${BASE_URL}/api/login" \
    -H 'Content-Type: application/json' \
    -d "${LOGIN_PAYLOAD}")"

  TOKEN="$(echo "${LOGIN_JSON}" | jq -r '.token // empty')"
  if [[ -z "${TOKEN}" ]]; then
    echo "[smoke] login failed: no token" >&2
    exit 1
  fi
fi

if [[ -z "${EVENT_ID}" ]]; then
  CLOSING_DATE="$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  if [[ -z "${CLOSING_DATE}" ]]; then
    CLOSING_DATE="$(date -u -v+2d +%Y-%m-%dT%H:%M:%SZ)"
  fi

  EVENT_TITLE="Smoke market $(date -u +%s)"
  EVENT_DETAILS="Temporary smoke market for matcher pipeline validation"

  echo "[smoke] creating event"
  EVENT_PAYLOAD="$(jq -cn \
    --arg title "${EVENT_TITLE}" \
    --arg details "${EVENT_DETAILS}" \
    --arg closing_date "${CLOSING_DATE}" \
    --arg domain "economics" \
    '{title:$title,details:$details,closing_date:$closing_date,domain:$domain}')"
  CREATE_RAW="$(curl -sS -X POST "${BASE_URL}/api/events" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "${EVENT_PAYLOAD}" \
    -w "\n%{http_code}")"

  CREATE_BODY="$(echo "${CREATE_RAW}" | sed '$d')"
  CREATE_STATUS="$(echo "${CREATE_RAW}" | tail -n1)"

  if [[ "${CREATE_STATUS}" =~ ^2 ]]; then
    EVENT_ID="$(echo "${CREATE_BODY}" | jq -r '.id // empty')"
  else
    echo "[smoke] event creation not permitted/status=${CREATE_STATUS}; falling back to existing events"
  fi
fi

if [[ -z "${EVENT_ID}" ]]; then
  EVENTS_JSON="$(curl -fsS "${BASE_URL}/api/events")"
  EVENT_ID="$(echo "${EVENTS_JSON}" | jq -r '
    map(select(.outcome == null))
    | sort_by(.closing_date // "9999-12-31T00:00:00Z")
    | .[0].id // empty
  ')"
  EVENT_TITLE_FALLBACK="$(echo "${EVENTS_JSON}" | jq -r --argjson id "${EVENT_ID:-0}" '
    map(select(.id == $id)) | .[0].title // empty
  ')"
else
  EVENT_TITLE_FALLBACK=""
fi

if [[ -n "${EVENT_ID}" ]]; then
  echo "[smoke] using event_id=${EVENT_ID}"
else
  echo "[smoke] no event selected; matcher check may be noisy"
fi

if [[ -z "${POST_CONTENT}" ]]; then
  if [[ -n "${EVENT_TITLE_FALLBACK}" ]]; then
    POST_CONTENT="Smoke post $(date -u +%s): ${EVENT_TITLE_FALLBACK}"
  else
    POST_CONTENT="Smoke post $(date -u +%s): The Federal Reserve will cut rates before end of year."
  fi
fi

echo "[smoke] creating post"
POST_PAYLOAD="$(jq -cn --arg content "${POST_CONTENT}" '{content:$content}')"
POST_RAW="$(curl -sS -X POST "${BASE_URL}/api/posts" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "${POST_PAYLOAD}" \
  -w "\n%{http_code}")"

POST_JSON="$(echo "${POST_RAW}" | sed '$d')"
POST_STATUS="$(echo "${POST_RAW}" | tail -n1)"

if [[ ! "${POST_STATUS}" =~ ^2 ]]; then
  echo "[smoke] post create failed status=${POST_STATUS}" >&2
  echo "${POST_JSON}" >&2
  exit 1
fi

POST_ID="$(echo "${POST_JSON}" | jq -r '.id // empty')"
if [[ -z "${POST_ID}" ]]; then
  echo "[smoke] post creation failed: no id in response" >&2
  echo "${POST_JSON}" >&2
  exit 1
fi

echo "[smoke] created post_id=${POST_ID}"
echo "[smoke] polling analysis status"

START_TS="$(date +%s)"
STATUS=""
while true; do
  STATUS_JSON="$(curl -fsS "${BASE_URL}/api/posts/${POST_ID}/analysis-status" \
    -H "Authorization: Bearer ${TOKEN}")"
  STATUS="$(echo "${STATUS_JSON}" | jq -r '.processing_status // "not_started"')"
  if [[ "${STATUS}" == "complete" || "${STATUS}" == "gated_out" || "${STATUS}" == "failed" ]]; then
    break
  fi

  NOW_TS="$(date +%s)"
  if (( NOW_TS - START_TS >= TIMEOUT_SECONDS )); then
    echo "[smoke] timeout waiting for analysis completion (last status=${STATUS})" >&2
    exit 1
  fi

  sleep 1
done

echo "[smoke] final analysis status=${STATUS}"

MARKETS_JSON="$(curl -fsS "${BASE_URL}/api/posts/${POST_ID}/markets" \
  -H "Authorization: Bearer ${TOKEN}")"
MARKETS_COUNT="$(echo "${MARKETS_JSON}" | jq -r '.markets | length')"

if [[ "${MARKETS_COUNT}" -lt "${EXPECT_MIN_MATCHES}" ]]; then
  echo "[smoke] FAIL: expected at least ${EXPECT_MIN_MATCHES} matched market(s), got ${MARKETS_COUNT}" >&2
  echo "${MARKETS_JSON}" >&2
  exit 1
fi

echo "[smoke] PASS: matched markets=${MARKETS_COUNT} for post_id=${POST_ID}"
