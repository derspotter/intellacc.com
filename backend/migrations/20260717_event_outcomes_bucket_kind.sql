-- Tail outcomes for open-bounded numeric markets (spec 2026-07-17):
-- 'inbound' = a regular bin, 'lower_tail' = X < range_min, 'upper_tail' = X > range_max.
ALTER TABLE event_outcomes
  ADD COLUMN IF NOT EXISTS bucket_kind TEXT NOT NULL DEFAULT 'inbound';

ALTER TABLE event_outcomes
  DROP CONSTRAINT IF EXISTS event_outcomes_bucket_kind_check;
ALTER TABLE event_outcomes
  ADD CONSTRAINT event_outcomes_bucket_kind_check
  CHECK (bucket_kind IN ('inbound', 'lower_tail', 'upper_tail'));
