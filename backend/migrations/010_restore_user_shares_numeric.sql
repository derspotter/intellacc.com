-- Restore user_shares precision to numeric with dependent view rebuilt
-- Keeps schema aligned with backend decimal expectations

BEGIN;

-- Drop dependent view prior to altering column types
DROP VIEW IF EXISTS market_summary;

ALTER TABLE user_shares
  ALTER COLUMN yes_shares TYPE NUMERIC(24,6)
    USING ROUND(COALESCE(yes_shares, 0)::NUMERIC, 6),
  ALTER COLUMN yes_shares SET DEFAULT 0,
  ALTER COLUMN yes_shares SET NOT NULL;

ALTER TABLE user_shares
  ALTER COLUMN no_shares TYPE NUMERIC(24,6)
    USING ROUND(COALESCE(no_shares, 0)::NUMERIC, 6),
  ALTER COLUMN no_shares SET DEFAULT 0,
  ALTER COLUMN no_shares SET NOT NULL;

-- Reassert non-negative constraints for clarity
ALTER TABLE user_shares
  DROP CONSTRAINT IF EXISTS user_shares_yes_non_negative;
ALTER TABLE user_shares
  ADD CONSTRAINT user_shares_yes_non_negative CHECK (yes_shares >= 0);

ALTER TABLE user_shares
  DROP CONSTRAINT IF EXISTS user_shares_no_non_negative;
ALTER TABLE user_shares
  ADD CONSTRAINT user_shares_no_non_negative CHECK (no_shares >= 0);

-- Recreate view dropped earlier with original definition
CREATE OR REPLACE VIEW market_summary AS
SELECT 
    e.id AS event_id,
    e.title,
    e.market_prob,
    e.cumulative_stake,
    e.liquidity_b,
    COUNT(DISTINCT mu.user_id) AS unique_traders,
    COUNT(mu.id) AS total_trades,
    COALESCE(SUM(us.yes_shares), 0) AS total_yes_shares,
    COALESCE(SUM(us.no_shares), 0) AS total_no_shares
FROM events e
LEFT JOIN market_updates mu ON e.id = mu.event_id
LEFT JOIN user_shares us ON e.id = us.event_id
WHERE e.market_prob IS NOT NULL
GROUP BY e.id, e.title, e.market_prob, e.cumulative_stake, e.liquidity_b;

COMMIT;
