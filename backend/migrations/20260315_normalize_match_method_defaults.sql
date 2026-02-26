-- 2026-03-15: Normalize post_market_matches.match_method for hybrid-only matching.
--
-- The matching add-on moved to hybrid-only candidate generation; existing fts
-- baseline labels are no longer produced by the runtime pipeline.

BEGIN;

UPDATE post_market_matches
   SET match_method = 'hybrid_v1'
 WHERE match_method IS NULL
    OR match_method = 'fts_v1';

ALTER TABLE post_market_matches
  ALTER COLUMN match_method SET DEFAULT 'hybrid_v1';

COMMIT;

