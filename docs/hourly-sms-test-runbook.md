# Hourly SMS 24h Test Runbook

## Purpose
Track the temporary hourly SMS reliability test (24 total sends) and document cleanup steps.

## What was configured
- Cron entry marker: `intellacc_hourly_sms_24h`
- Tick script: `/tmp/hourly_sms_tick.sh`
- State file: `/tmp/hourly_sms_24h.state`
- Log file: `/tmp/hourly_sms_24h.log`
- Last API response snapshot: `/tmp/hourly_sms_last_response.json`

The cron runs every minute, but the script enforces a `>= 3600s` gate, so actual sends occur hourly.
The script removes its own cron entry after `count >= 24`.

## Check progress
```bash
cat /tmp/hourly_sms_24h.state
tail -n 50 /tmp/hourly_sms_24h.log
crontab -l | grep intellacc_hourly_sms_24h || echo "cron entry removed"
```

## Stop early (manual cancel)
```bash
crontab -l | grep -v intellacc_hourly_sms_24h | crontab -
echo "[$(date -Is)] manually stopped hourly SMS test" >> /tmp/hourly_sms_24h.log
```

## Cleanup after completion
Run once `count=24` (or after manual stop):

```bash
# Ensure cron entry is gone
crontab -l | grep -v intellacc_hourly_sms_24h | crontab -

# Remove temporary runtime files
rm -f /tmp/hourly_sms_tick.sh
rm -f /tmp/hourly_sms_24h.state
rm -f /tmp/hourly_sms_24h.log
rm -f /tmp/hourly_sms_last_response.json
```

## Verify cleanup
```bash
crontab -l | grep intellacc_hourly_sms_24h && echo "still present" || echo "removed"
ls -l /tmp/hourly_sms_* 2>/dev/null || echo "no temp sms test files"
```

