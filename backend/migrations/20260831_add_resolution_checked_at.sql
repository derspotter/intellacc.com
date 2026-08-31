-- Fairness cursor for the prediction engine's resolution sync. The sync now
-- also polls future-close manifold/polymarket events (those providers settle
-- early, long before the listed close date), so batches are ordered by
-- least-recently-checked instead of close date to guarantee every candidate
-- gets its turn under the per-run LIMIT.
ALTER TABLE events ADD COLUMN IF NOT EXISTS resolution_checked_at TIMESTAMPTZ;
