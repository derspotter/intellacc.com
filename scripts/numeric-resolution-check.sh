#!/bin/bash
# Weekly detection of closed-but-unresolved numeric/MC markets with stuck
# user positions (see docs/ops/numeric-market-resolution.md). A closed,
# unresolved market freezes every holder's staked RP.
#
# Emails the priority rows (open positions or frozen basis > 0) to
# kontakt@intellacc.com via the local inbound postfix. No stuck rows -> no
# mail (silence means nothing to do; the ~660 zero-position legacy rows are
# deliberately excluded).
set -euo pipefail

REPORT=$(docker exec intellacc_db psql -U intellacc_user -d intellaccdb -At -F' | ' -c "
SELECT e.id, e.event_type, LEFT(e.title, 60), e.closing_date::date,
       COALESCE(s.external_url, '-'),
       (SELECT COUNT(*) FROM user_outcome_shares u
         WHERE u.event_id = e.id AND u.shares > 0),
       (SELECT COALESCE(SUM(b.basis_ledger), 0) FROM numeric_position_basis b
         WHERE b.event_id = e.id)
FROM events e
LEFT JOIN event_external_sources s ON s.event_id = e.id
WHERE e.closing_date < NOW()
  AND e.resolved_at IS NULL
  AND e.outcome IS NULL
  AND e.event_type IN ('numeric', 'multiple_choice')
  AND e.hidden_at IS NULL
  AND (
    EXISTS (SELECT 1 FROM user_outcome_shares u
             WHERE u.event_id = e.id AND u.shares > 0)
    OR COALESCE((SELECT SUM(b.basis_ledger) FROM numeric_position_basis b
                  WHERE b.event_id = e.id), 0) > 0
  )
ORDER BY 7 DESC, e.closing_date;")

if [ -z "$REPORT" ]; then
  echo "[numeric-check] $(date +%F) no stuck markets"
  exit 0
fi

COUNT=$(echo "$REPORT" | wc -l)
{
  printf 'From: numeric-check@intellacc.com\r\n'
  printf 'To: kontakt@intellacc.com\r\n'
  printf 'Subject: [intellacc] %s stuck market(s) need manual resolution\r\n' "$COUNT"
  printf '\r\n'
  printf 'Closed, unresolved markets with user positions (id | type | title | closed | source | positions | frozen basis):\r\n\r\n'
  printf '%s\r\n' "$REPORT"
  printf '\r\nResolve per docs/ops/numeric-market-resolution.md (PATCH /api/events/<id>).\r\n'
} | curl -s --url smtp://127.0.0.1:25 \
      --mail-from numeric-check@intellacc.com \
      --mail-rcpt kontakt@intellacc.com \
      --upload-file -

echo "[numeric-check] $(date +%F) mailed report: $COUNT stuck market(s)"
