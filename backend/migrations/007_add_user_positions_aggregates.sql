-- Migration: Add aggregated position tracking to eliminate SUM() queries in loops
-- This fixes the critical O(N * history) performance bottleneck

-- Add aggregated fields to user_shares table
ALTER TABLE user_shares 
ADD COLUMN IF NOT EXISTS total_staked_ledger BIGINT DEFAULT 0,  -- Fixed-point RP in micro units (1/1,000,000)
ADD COLUMN IF NOT EXISTS realized_pnl_ledger BIGINT DEFAULT 0,  -- Running P&L in micro units
ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;             -- For optimistic concurrency control

-- Create index for efficient lookups during resolution
CREATE INDEX IF NOT EXISTS idx_user_shares_event_version ON user_shares(event_id, version);

-- Update existing records to populate the new fields from market_updates history
-- This is a one-time backfill for existing data
UPDATE user_shares 
SET total_staked_ledger = COALESCE(
    (SELECT ROUND(SUM(stake_amount) * 1000000)::BIGINT 
     FROM market_updates 
     WHERE market_updates.user_id = user_shares.user_id 
       AND market_updates.event_id = user_shares.event_id), 
    0
);

-- Add constraints to ensure data integrity
ALTER TABLE user_shares
DROP CONSTRAINT IF EXISTS user_shares_total_staked_non_negative;
ALTER TABLE user_shares
ADD CONSTRAINT user_shares_total_staked_non_negative CHECK (total_staked_ledger >= 0);
ALTER TABLE user_shares
DROP CONSTRAINT IF EXISTS user_shares_version_positive;
ALTER TABLE user_shares
ADD CONSTRAINT user_shares_version_positive CHECK (version > 0);

-- Create a function to convert between decimal and ledger units
CREATE OR REPLACE FUNCTION decimal_to_ledger(decimal_val NUMERIC) RETURNS BIGINT AS $$
BEGIN
    RETURN ROUND(decimal_val * 1000000)::BIGINT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION ledger_to_decimal(ledger_val BIGINT) RETURNS NUMERIC AS $$
BEGIN
    RETURN (ledger_val::NUMERIC / 1000000);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Add comment for documentation
COMMENT ON COLUMN user_shares.total_staked_ledger IS 'Total stake amount in micro-RP units (1/1,000,000 RP) to eliminate SUM() queries';
COMMENT ON COLUMN user_shares.realized_pnl_ledger IS 'Running realized profit/loss in micro-RP units';
COMMENT ON COLUMN user_shares.version IS 'Version number for optimistic concurrency control';