-- Drop legacy SQL objects/columns and align market state with float storage

BEGIN;

-- Legacy view/functions (not used by app code)
DROP VIEW IF EXISTS market_summary;
DROP FUNCTION IF EXISTS format_ledger_to_decimal(BIGINT);
DROP FUNCTION IF EXISTS parse_decimal_to_ledger(TEXT);
DROP FUNCTION IF EXISTS decimal_to_ledger(NUMERIC);
DROP FUNCTION IF EXISTS ledger_to_decimal(BIGINT);

-- Ledger is the source of truth for balances
ALTER TABLE users
  DROP COLUMN IF EXISTS rp_balance,
  DROP COLUMN IF EXISTS rp_staked;

-- Remove unused float duplicates introduced during ledger migration
ALTER TABLE events
  DROP COLUMN IF EXISTS q_yes_f64,
  DROP COLUMN IF EXISTS q_no_f64,
  DROP COLUMN IF EXISTS b_f64;

-- Align market state with engine f64 math
ALTER TABLE events
  ALTER COLUMN market_prob TYPE DOUBLE PRECISION USING market_prob::DOUBLE PRECISION,
  ALTER COLUMN liquidity_b TYPE DOUBLE PRECISION USING liquidity_b::DOUBLE PRECISION,
  ALTER COLUMN q_yes TYPE DOUBLE PRECISION USING q_yes::DOUBLE PRECISION,
  ALTER COLUMN q_no TYPE DOUBLE PRECISION USING q_no::DOUBLE PRECISION,
  ALTER COLUMN cumulative_stake TYPE DOUBLE PRECISION USING cumulative_stake::DOUBLE PRECISION;

-- Align shares with engine f64 math
ALTER TABLE user_shares
  ALTER COLUMN yes_shares TYPE DOUBLE PRECISION USING yes_shares::DOUBLE PRECISION,
  ALTER COLUMN no_shares TYPE DOUBLE PRECISION USING no_shares::DOUBLE PRECISION;

-- Align trade log with engine f64 math
ALTER TABLE market_updates
  ALTER COLUMN prev_prob TYPE DOUBLE PRECISION USING prev_prob::DOUBLE PRECISION,
  ALTER COLUMN new_prob TYPE DOUBLE PRECISION USING new_prob::DOUBLE PRECISION,
  ALTER COLUMN stake_amount TYPE DOUBLE PRECISION USING stake_amount::DOUBLE PRECISION,
  ALTER COLUMN shares_acquired TYPE DOUBLE PRECISION USING shares_acquired::DOUBLE PRECISION;

COMMIT;
