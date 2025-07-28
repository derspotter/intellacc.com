-- 2025-07-27: Sync NUMERIC columns with ledger precision
-- Fixes precision mismatches detected by balance invariant verification

BEGIN;

-- Update all users' NUMERIC columns to match their ledger values exactly
-- This eliminates the precision discrepancies between NUMERIC(15,2) and ledger units
UPDATE users
SET 
    rp_balance = (rp_balance_ledger::NUMERIC / 1000000.0),
    rp_staked  = (rp_staked_ledger::NUMERIC  / 1000000.0)
WHERE rp_balance_ledger != 0 OR rp_staked_ledger != 0;

-- Verify the sync worked by checking for any remaining mismatches
-- Note: NUMERIC(15,2) columns will be rounded to 2dp, so we expect small differences
DO $$
DECLARE
    mismatch_count INTEGER;
    tolerance_ledger BIGINT := 10000; -- 0.01 RP tolerance (2dp rounding)
BEGIN
    SELECT COUNT(*) INTO mismatch_count
    FROM users
    WHERE ABS((rp_balance * 1000000.0)::BIGINT - rp_balance_ledger) > tolerance_ledger
       OR ABS((rp_staked  * 1000000.0)::BIGINT - rp_staked_ledger)  > tolerance_ledger;
    
    IF mismatch_count > 0 THEN
        RAISE EXCEPTION 'NUMERIC/ledger sync failed: % users still have precision mismatches', mismatch_count;
    END IF;
    
    RAISE NOTICE 'NUMERIC/ledger precision sync completed successfully for all users';
END $$;

COMMIT;

-- Post-migration verification query (run separately to check results)
/*
SELECT 
    id,
    rp_balance,
    rp_balance_ledger,
    (rp_balance_ledger::NUMERIC / 1000000.0) as ledger_as_rp,
    CASE 
        WHEN ABS((rp_balance * 1000000.0)::BIGINT - rp_balance_ledger) = 0 
        THEN 'MATCH' 
        ELSE 'MISMATCH' 
    END as balance_status,
    rp_staked,
    rp_staked_ledger,
    (rp_staked_ledger::NUMERIC / 1000000.0) as staked_ledger_as_rp,
    CASE 
        WHEN ABS((rp_staked * 1000000.0)::BIGINT - rp_staked_ledger) = 0 
        THEN 'MATCH' 
        ELSE 'MISMATCH' 
    END as staked_status
FROM users 
WHERE id = 1003;
*/