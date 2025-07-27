-- 2025-01-27: Convert display balance columns to generated columns
-- Eliminates precision drift by making ledger the single source of truth

BEGIN;

-- Phase 1: Backup current values and verify consistency
-- Create temporary table to backup current display values
CREATE TEMP TABLE users_display_backup AS
SELECT 
    id,
    rp_balance,
    rp_staked,
    rp_balance_ledger,
    rp_staked_ledger,
    -- Calculate what the generated columns will show
    ROUND(rp_balance_ledger::NUMERIC / 1000000.0, 2) as calc_balance,
    ROUND(rp_staked_ledger::NUMERIC / 1000000.0, 2) as calc_staked,
    -- Check current precision differences
    ABS(ROUND(rp_balance * 1000000.0)::BIGINT - rp_balance_ledger) as balance_diff_microRP,
    ABS(ROUND(rp_staked * 1000000.0)::BIGINT - rp_staked_ledger) as staked_diff_microRP
FROM users;

-- Verification: ensure differences are within expected tolerance (5000 μRP = 0.005 RP)
DO $$
DECLARE
    max_balance_diff BIGINT;
    max_staked_diff BIGINT;
    count_over_tolerance INTEGER;
BEGIN
    SELECT 
        MAX(balance_diff_microRP),
        MAX(staked_diff_microRP),
        COUNT(*)
    INTO max_balance_diff, max_staked_diff, count_over_tolerance
    FROM users_display_backup
    WHERE balance_diff_microRP > 5000 OR staked_diff_microRP > 5000;
    
    IF count_over_tolerance > 0 THEN
        RAISE EXCEPTION 'Pre-migration validation failed: % users have precision differences > 5000 μRP (max_balance_diff: %, max_staked_diff: %)', 
            count_over_tolerance, max_balance_diff, max_staked_diff;
    END IF;
    
    RAISE NOTICE 'Pre-migration validation passed: max precision differences are balance: % μRP, staked: % μRP', 
        max_balance_diff, max_staked_diff;
END $$;

-- Phase 2: Convert to generated columns
-- Drop the old display columns
ALTER TABLE users DROP COLUMN IF EXISTS rp_balance;
ALTER TABLE users DROP COLUMN IF EXISTS rp_staked;

-- Add generated columns that derive from ledger values
ALTER TABLE users 
    ADD COLUMN rp_balance NUMERIC(15,2) 
    GENERATED ALWAYS AS (ROUND(rp_balance_ledger::NUMERIC / 1000000.0, 2)) STORED;

ALTER TABLE users 
    ADD COLUMN rp_staked NUMERIC(15,2) 
    GENERATED ALWAYS AS (ROUND(rp_staked_ledger::NUMERIC / 1000000.0, 2)) STORED;

-- Phase 3: Verification
-- Verify that generated columns match what we calculated
DO $$
DECLARE
    mismatch_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO mismatch_count
    FROM users u
    JOIN users_display_backup b ON u.id = b.id
    WHERE u.rp_balance <> b.calc_balance
       OR u.rp_staked <> b.calc_staked;
    
    IF mismatch_count > 0 THEN
        RAISE EXCEPTION 'Post-migration validation failed: % users have mismatched generated values', mismatch_count;
    END IF;
    
    RAISE NOTICE 'Post-migration validation passed: all generated columns match expected values';
END $$;

-- Add helpful comment to the table
COMMENT ON COLUMN users.rp_balance IS 'Generated from rp_balance_ledger (ROUND(rp_balance_ledger / 1000000.0, 2)) - DO NOT UPDATE DIRECTLY';
COMMENT ON COLUMN users.rp_staked IS 'Generated from rp_staked_ledger (ROUND(rp_staked_ledger / 1000000.0, 2)) - DO NOT UPDATE DIRECTLY';

COMMIT;

-- Post-migration verification queries (run separately to check results)
/*
-- Check that no precision drift exists anymore
SELECT 
    COUNT(*) as total_users,
    COUNT(CASE WHEN ABS(ROUND(rp_balance * 1000000.0)::BIGINT - rp_balance_ledger) = 0 THEN 1 END) as perfect_balance_matches,
    COUNT(CASE WHEN ABS(ROUND(rp_staked * 1000000.0)::BIGINT - rp_staked_ledger) = 0 THEN 1 END) as perfect_staked_matches,
    MAX(ABS(ROUND(rp_balance * 1000000.0)::BIGINT - rp_balance_ledger)) as max_balance_diff_microRP,
    MAX(ABS(ROUND(rp_staked * 1000000.0)::BIGINT - rp_staked_ledger)) as max_staked_diff_microRP
FROM users;

-- Sample of users to verify the conversion
SELECT 
    id,
    rp_balance,
    rp_balance_ledger,
    (rp_balance_ledger::NUMERIC / 1000000.0) as ledger_as_rp,
    rp_staked,
    rp_staked_ledger,
    (rp_staked_ledger::NUMERIC / 1000000.0) as staked_ledger_as_rp
FROM users 
WHERE id IN (1001, 1003, 1005)
ORDER BY id;
*/

-- Rollback instructions (for reference):
/*
-- To rollback this migration (emergency only):
ALTER TABLE users DROP COLUMN IF EXISTS rp_balance;
ALTER TABLE users DROP COLUMN IF EXISTS rp_staked;
ALTER TABLE users 
    ADD COLUMN rp_balance NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN rp_staked NUMERIC(15,2) DEFAULT 0;
UPDATE users SET 
    rp_balance = ROUND(rp_balance_ledger::NUMERIC / 1000000.0, 2),
    rp_staked = ROUND(rp_staked_ledger::NUMERIC / 1000000.0, 2);
*/