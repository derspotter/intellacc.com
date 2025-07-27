-- Migration to fixed-point ledger system (i128 micro-RP units)
-- 1 RP = 1,000,000 micro-RP units

BEGIN;

-- Add new columns for ledger units (BIGINT = i64, sufficient for i128 in practice)
ALTER TABLE users 
  ADD COLUMN rp_balance_ledger BIGINT DEFAULT 0,
  ADD COLUMN rp_staked_ledger BIGINT DEFAULT 0;

-- Convert existing decimal values to ledger units (multiply by 1,000,000)
UPDATE users 
SET 
  rp_balance_ledger = ROUND(rp_balance * 1000000)::BIGINT,
  rp_staked_ledger = ROUND(rp_staked * 1000000)::BIGINT;

-- Add new columns for f64 market state
ALTER TABLE events
  ADD COLUMN q_yes_f64 DOUBLE PRECISION DEFAULT 0.0,
  ADD COLUMN q_no_f64 DOUBLE PRECISION DEFAULT 0.0,
  ADD COLUMN b_f64 DOUBLE PRECISION DEFAULT 5000.0;

-- Copy existing market state to f64 columns
UPDATE events
SET
  q_yes_f64 = q_yes::DOUBLE PRECISION,
  q_no_f64 = q_no::DOUBLE PRECISION,
  b_f64 = liquidity_b::DOUBLE PRECISION;

-- Convert user shares to DOUBLE PRECISION
ALTER TABLE user_shares
  ALTER COLUMN yes_shares TYPE DOUBLE PRECISION USING yes_shares::DOUBLE PRECISION,
  ALTER COLUMN no_shares TYPE DOUBLE PRECISION USING no_shares::DOUBLE PRECISION;

-- Add constraints
ALTER TABLE users
  ADD CONSTRAINT rp_balance_ledger_non_negative CHECK (rp_balance_ledger >= 0),
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
CREATE INDEX idx_users_rp_balance_ledger ON users(rp_balance_ledger);
CREATE INDEX idx_users_rp_staked_ledger ON users(rp_staked_ledger);

COMMIT;

-- Note: After verifying the migration, you can drop the old decimal columns:
-- ALTER TABLE users DROP COLUMN rp_balance, DROP COLUMN rp_staked;
-- ALTER TABLE events DROP COLUMN q_yes, DROP COLUMN q_no, DROP COLUMN liquidity_b;