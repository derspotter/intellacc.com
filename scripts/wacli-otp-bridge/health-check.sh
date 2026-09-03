#!/usr/bin/env bash
# Health check for the shared wacli WhatsApp session.
#
# WHY: the session serves BOTH the Kanzlei intake alarms AND Intellacc phone
# OTP. On 2026-08-28 the linked device was de-authenticated and nothing
# noticed for ~5.5 days — the sync daemon kept running (green to systemd)
# while every send silently failed with "not authenticated". A dropped
# socket self-heals (daemon runs --max-reconnect 0 = unlimited retries); a
# DE-AUTH does not — it needs a human to re-pair via `wacli auth --phone`.
# `wacli auth status` is the reliable, lock-safe signal for that state.
#
# Alerts are debounced via a state file so a broken session mails once on
# the ok->broken transition (and once on recovery), not every run.
set -u

WACLI_BIN="${WACLI_BIN:-$HOME/.local/bin/wacli}"
STATE_FILE="${STATE_FILE:-$HOME/.local/state/wacli-otp-bridge/health.state}"
ALERT_TO="${ALERT_TO:-kontakt@intellacc.com}"
ALERT_FROM="${ALERT_FROM:-wacli-health@intellacc.com}"
SMTP_URL="${SMTP_URL:-smtp://127.0.0.1:25}"

mkdir -p "$(dirname "$STATE_FILE")"
prev="$(cat "$STATE_FILE" 2>/dev/null || echo unknown)"

status_out="$(timeout 25 "$WACLI_BIN" auth status 2>&1)"
if printf '%s' "$status_out" | grep -q "Authenticated as"; then
  cur=ok
else
  cur=broken
fi

send_mail() {
  local subject="$1" body="$2"
  {
    printf 'From: %s\r\n' "$ALERT_FROM"
    printf 'To: %s\r\n' "$ALERT_TO"
    printf 'Subject: %s\r\n\r\n' "$subject"
    printf '%s\r\n' "$body"
  } | curl -s --url "$SMTP_URL" \
        --mail-from "$ALERT_FROM" \
        --mail-rcpt "$ALERT_TO" \
        --upload-file - >/dev/null 2>&1
}

if [ "$cur" != "$prev" ]; then
  if [ "$cur" = broken ]; then
    send_mail "[wacli] WhatsApp session DOWN — intake alarms + Intellacc OTP not delivering" \
"wacli auth status is no longer authenticated. Both Kanzlei intake WhatsApp
alarms and Intellacc phone-OTP delivery are DOWN until the linked device is
re-paired.

Fix (needs the phone owning 4915129780850):
  systemctl --user stop wacli-sync.service
  wacli auth --phone 4915129780850   # enter the code on the phone
  systemctl --user start wacli-sync.service

wacli auth status output:
$status_out"
  else
    send_mail "[wacli] WhatsApp session recovered" \
"wacli auth status is authenticated again. Intake alarms and Intellacc OTP
delivery are restored."
  fi
  printf '%s\n' "$cur" > "$STATE_FILE"
fi

# Non-zero exit while broken so `systemctl --user status` also reflects it.
[ "$cur" = ok ]
