# Runbook: resolving numeric & stuck multiple-choice markets

Numeric markets NEVER auto-resolve: Metaculus hides `question.resolution`
at our API token tier, so `resolution_sync` has nothing to read. MC markets
auto-resolve by label match but fail safe (leave `outcome IS NULL`) on any
mismatch/ambiguity. Sells lock at `closing_date` — a closed, unresolved
market freezes every holder's staked RP until an admin resolves it.
**Run the detection query weekly** (or after any Metaculus import sync).

## 1. Detect

```sql
-- closed, unresolved numeric + MC markets, with open-position counts
SELECT e.id, e.event_type, LEFT(e.title, 60) AS title, e.closing_date,
       s.source, s.external_url,
       (SELECT COUNT(*) FROM user_outcome_shares u
         WHERE u.event_id = e.id AND u.shares > 0)  AS open_positions,
       (SELECT COALESCE(SUM(b.basis_ledger), 0) FROM numeric_position_basis b
         WHERE b.event_id = e.id)                    AS frozen_basis_ledger
FROM events e
LEFT JOIN event_external_sources s ON s.event_id = e.id
WHERE e.closing_date < NOW()
  AND e.resolved_at IS NULL
  AND e.outcome IS NULL
  AND e.event_type IN ('numeric', 'multiple_choice')
  AND e.hidden_at IS NULL
ORDER BY frozen_basis_ledger DESC, e.closing_date;
```

Priority: anything with `open_positions > 0` or `frozen_basis_ledger > 0`.

## 2. Find the true outcome

Open `external_url` (Metaculus/Manifold) and read the resolved value there.

## 3. Resolve

Preferred — through the backend (admin JWT; logs, idempotency guard):

```bash
# numeric: pass the resolved numerical value; engine picks the winning bin
curl -X PATCH https://intellacc.com/api/events/<EVENT_ID> \
  -H "Authorization: Bearer <ADMIN_JWT>" -H "Content-Type: application/json" \
  -d '{"numerical_outcome": <VALUE>}'

# multiple-choice: resolve by outcome id (SELECT id, label FROM event_outcomes WHERE event_id = <EVENT_ID>)
curl -X PATCH https://intellacc.com/api/events/<EVENT_ID> \
  -H "Authorization: Bearer <ADMIN_JWT>" -H "Content-Type: application/json" \
  -d '{"outcome_id": <OUTCOME_ID>}'
```

Fallback — engine direct from the host (shared secret from `prediction-engine/.env`):

```bash
docker exec intellacc_backend node -e "
fetch('http://prediction-engine:3001/events/<EVENT_ID>/market-resolve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json',
             'x-engine-token': process.env.PREDICTION_ENGINE_AUTH_TOKEN },
  body: JSON.stringify({ numerical_outcome: <VALUE> })
}).then(r => r.json()).then(j => console.log(JSON.stringify(j)))"
```

## 4. Verify settlement

```bash
# invariant check (expects {"valid": true})
docker exec intellacc_backend node -e "
fetch('http://prediction-engine:3001/lmsr/verify-post-resolution', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json',
             'x-engine-token': process.env.PREDICTION_ENGINE_AUTH_TOKEN },
  body: JSON.stringify({ event_id: <EVENT_ID> })
}).then(r => r.json()).then(j => console.log(JSON.stringify(j)))"
```

The response's `details` object reports `remaining_shares` (binary),
`remaining_outcome_shares` (multiple-choice), and `remaining_numeric_basis`
(numeric) — all three must be `0` for `valid: true`. These last two were
generalized beyond the original binary-only `user_shares` check, so a
non-zero value pinpoints which market type still has open state.

## 5. Junk disposal

A closed market that can never resolve (dead source, stale labels) AND has
zero open positions and zero basis can be hidden instead:

```sql
UPDATE events SET hidden_at = NOW(), hidden_reason = '<why>'
WHERE id = <EVENT_ID>
  AND NOT EXISTS (SELECT 1 FROM user_outcome_shares u WHERE u.event_id = events.id AND u.shares > 0)
  AND NOT EXISTS (SELECT 1 FROM numeric_position_basis b WHERE b.event_id = events.id AND b.basis_ledger > 0);
```

NEVER hide a market with open positions — resolve it (or escalate) instead.
