-- 2026-03-14: Add match scoring fields used by agentic matching proposal payloads.

BEGIN;

ALTER TABLE post_market_links
  ADD COLUMN IF NOT EXISTS match_score REAL;

ALTER TABLE post_market_links
  ADD COLUMN IF NOT EXISTS match_method VARCHAR(20);

COMMIT;

