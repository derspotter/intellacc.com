-- Migration: Add side-specific cost basis tracking to user_shares
-- This enables exact cost basis accounting for mixed YES/NO positions

BEGIN;

-- Add the new side-specific stake columns
ALTER TABLE user_shares
    ADD COLUMN staked_yes_ledger BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN staked_no_ledger  BIGINT NOT NULL DEFAULT 0;

-- Create a temporary backup of current state for verification
CREATE TEMP TABLE migration_verification AS
SELECT 
    user_id,
    event_id,
    yes_shares,
    no_shares,
    total_staked_ledger,
    (yes_shares + no_shares) as total_shares
FROM user_shares
WHERE (yes_shares > 0 OR no_shares > 0) AND total_staked_ledger > 0;

-- Migrate existing data: distribute total_staked_ledger proportionally
-- based on current share ratios
UPDATE user_shares 
SET 
    staked_yes_ledger = CASE 
        WHEN (yes_shares + no_shares) > 0 
        THEN CAST(total_staked_ledger * (yes_shares / (yes_shares + no_shares)) AS BIGINT)
        ELSE 0 
    END,
    staked_no_ledger = CASE 
        WHEN (yes_shares + no_shares) > 0 
        THEN CAST(total_staked_ledger * (no_shares / (yes_shares + no_shares)) AS BIGINT)
        ELSE 0 
    END
WHERE total_staked_ledger > 0 AND (yes_shares > 0 OR no_shares > 0);

-- Handle rounding: ensure staked_yes_ledger + staked_no_ledger = total_staked_ledger
-- by adjusting the larger side by any rounding difference
UPDATE user_shares 
SET staked_yes_ledger = staked_yes_ledger + (total_staked_ledger - staked_yes_ledger - staked_no_ledger)
WHERE total_staked_ledger > 0 
  AND (staked_yes_ledger + staked_no_ledger) != total_staked_ledger
  AND yes_shares >= no_shares;

UPDATE user_shares 
SET staked_no_ledger = staked_no_ledger + (total_staked_ledger - staked_yes_ledger - staked_no_ledger)
WHERE total_staked_ledger > 0 
  AND (staked_yes_ledger + staked_no_ledger) != total_staked_ledger
  AND no_shares > yes_shares;

-- Verify migration integrity
DO $$
DECLARE
    before_total BIGINT;
    after_total BIGINT;
    mismatch_count INTEGER;
BEGIN
    -- Check total stake preservation
    SELECT COALESCE(SUM(total_staked_ledger), 0) INTO before_total FROM user_shares;
    SELECT COALESCE(SUM(staked_yes_ledger + staked_no_ledger), 0) INTO after_total FROM user_shares;
    
    IF before_total != after_total THEN
        RAISE EXCEPTION 'Migration failed: total stake mismatch. Before: %, After: %', before_total, after_total;
    END IF;
    
    -- Check for any rows where the sum doesn't match (should be 0 after rounding fix)
    SELECT COUNT(*) INTO mismatch_count 
    FROM user_shares 
    WHERE total_staked_ledger != (staked_yes_ledger + staked_no_ledger);
    
    IF mismatch_count > 0 THEN
        RAISE EXCEPTION 'Migration failed: % rows have stake sum mismatches', mismatch_count;
    END IF;
    
    RAISE NOTICE 'Migration verification passed. Total stake preserved: % ledger units', before_total;
END $$;

-- Add constraints to ensure data integrity going forward
ALTER TABLE user_shares 
    ADD CONSTRAINT user_shares_staked_yes_nonnegative 
    CHECK (staked_yes_ledger >= 0);

ALTER TABLE user_shares 
    ADD CONSTRAINT user_shares_staked_no_nonnegative 
    CHECK (staked_no_ledger >= 0);

-- Add a consistency check constraint (can be removed later when total_staked_ledger is deprecated)
ALTER TABLE user_shares 
    ADD CONSTRAINT user_shares_stake_consistency 
    CHECK (total_staked_ledger = (staked_yes_ledger + staked_no_ledger));

-- Create indexes for performance
CREATE INDEX idx_user_shares_staked_yes ON user_shares(staked_yes_ledger) WHERE staked_yes_ledger > 0;
CREATE INDEX idx_user_shares_staked_no ON user_shares(staked_no_ledger) WHERE staked_no_ledger > 0;

-- Log migration results
INSERT INTO migration_log (migration_name, applied_at, description) 
VALUES (
    'add_side_specific_stakes', 
    NOW(), 
    'Added staked_yes_ledger and staked_no_ledger columns with proportional distribution of existing stakes'
) ON CONFLICT DO NOTHING;

COMMIT;

-- Post-migration verification query (run separately to check results)
/*
SELECT 
    'Before migration' as phase,
    COUNT(*) as positions,
    SUM(total_staked_ledger) as total_stake_ledger_units,
    SUM(total_staked_ledger)::NUMERIC / 1000000.0 as total_stake_rp
FROM migration_verification
UNION ALL
SELECT 
    'After migration' as phase,
    COUNT(*) as positions,
    SUM(staked_yes_ledger + staked_no_ledger) as total_stake_ledger_units,
    SUM(staked_yes_ledger + staked_no_ledger)::NUMERIC / 1000000.0 as total_stake_rp
FROM user_shares 
WHERE staked_yes_ledger > 0 OR staked_no_ledger > 0;
*/