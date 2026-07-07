-- Settlement deletes user share rows, so events.resolved_at is the only
-- durable record of WHEN a market resolved — needed for the "recently
-- resolved" window in the My Positions section.
ALTER TABLE events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Approximate backfill for events resolved before this column existed.
-- updated_at is a rough proxy (resolved markets stop trading), good enough
-- for a 7-day display window.
UPDATE events
SET resolved_at = updated_at
WHERE outcome IS NOT NULL AND resolved_at IS NULL;
