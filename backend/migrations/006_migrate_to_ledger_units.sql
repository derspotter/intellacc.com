-- Migration to fixed-point ledger system (i128 micro-RP units)
-- 1 RP = 1,000,000 micro-RP units

BEGIN;

-- Add new columns for ledger units (BIGINT = i64, sufficient for i128 in practice)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS rp_balance_ledger BIGINT DEFAULT 0;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS rp_staked_ledger BIGINT DEFAULT 0;

-- Convert existing decimal values to ledger units (multiply by 1,000,000)
UPDATE users 
SET 
  rp_balance_ledger = ROUND(rp_balance * 1000000)::BIGINT,
  rp_staked_ledger = ROUND(rp_staked * 1000000)::BIGINT;

-- Add new columns for f64 market state
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS q_yes_f64 DOUBLE PRECISION DEFAULT 0.0;
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS q_no_f64 DOUBLE PRECISION DEFAULT 0.0;
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS b_f64 DOUBLE PRECISION DEFAULT 5000.0;

-- Copy existing market state to f64 columns
UPDATE events
SET
  q_yes_f64 = q_yes::DOUBLE PRECISION,
  q_no_f64 = q_no::DOUBLE PRECISION,
  b_f64 = liquidity_b::DOUBLE PRECISION;

-- Convert user shares to DOUBLE PRECISION (while preserving dependent views)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'user_shares'
      AND column_name = 'yes_shares'
      AND data_type <> 'double precision'
  ) THEN
    EXECUTE 'DROP VIEW IF EXISTS market_summary';
    EXECUTE 'ALTER TABLE user_shares ALTER COLUMN yes_shares TYPE DOUBLE PRECISION USING yes_shares::DOUBLE PRECISION';
    EXECUTE 'ALTER TABLE user_shares ALTER COLUMN no_shares TYPE DOUBLE PRECISION USING no_shares::DOUBLE PRECISION';
    EXECUTE $view$
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
    $view$;
  END IF;
END
$$;

-- Add constraints
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS rp_balance_ledger_non_negative;
ALTER TABLE users
  ADD CONSTRAINT rp_balance_ledger_non_negative CHECK (rp_balance_ledger >= 0);
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS rp_staked_ledger_non_negative;
ALTER TABLE users
  ADD CONSTRAINT rp_staked_ledger_non_negative CHECK (rp_staked_ledger >= 0);

-- Create function to format ledger units for display
CREATE OR REPLACE FUNCTION format_ledger_to_decimal(ledger_value BIGINT) 
RETURNS TEXT AS $$
BEGIN
  RETURN (ledger_value::NUMERIC / 1000000)::TEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create function to parse decimal to ledger units
CREATE OR REPLACE FUNCTION parse_decimal_to_ledger(decimal_value TEXT) 
RETURNS BIGINT AS $$
BEGIN
  RETURN ROUND((decimal_value::NUMERIC) * 1000000)::BIGINT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_rp_balance_ledger ON users(rp_balance_ledger);
CREATE INDEX IF NOT EXISTS idx_users_rp_staked_ledger ON users(rp_staked_ledger);

COMMIT;

-- Note: After verifying the migration, you can drop the old decimal columns:
-- ALTER TABLE users DROP COLUMN rp_balance, DROP COLUMN rp_staked;
-- ALTER TABLE events DROP COLUMN q_yes, DROP COLUMN q_no, DROP COLUMN liquidity_b;