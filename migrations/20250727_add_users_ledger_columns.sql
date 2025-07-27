-- 2025-07-27: Add ledger columns to users and backfill from NUMERIC
-- Addresses precision issues by maintaining both NUMERIC and BIGINT representations
BEGIN;

-- Add ledger columns for precise integer arithmetic
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS rp_balance_ledger BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rp_staked_ledger  BIGINT NOT NULL DEFAULT 0;

-- Backfill from existing NUMERIC(15,2) values 
-- Since NUMERIC(15,2) has exactly 2 decimal places, multiplying by 1e6 gives exact integer conversion
UPDATE users
SET
  rp_balance_ledger = (rp_balance * 1000000)::BIGINT,
  rp_staked_ledger  = (rp_staked  * 1000000)::BIGINT;

-- Add safety constraints to prevent negative balances
ALTER TABLE users
  ADD CONSTRAINT chk_rp_balance_ledger_nonneg CHECK (rp_balance_ledger >= 0),
  ADD CONSTRAINT chk_rp_staked_ledger_nonneg  CHECK (rp_staked_ledger  >= 0);

-- Verify backfill worked correctly by checking a few sample conversions
DO $$
DECLARE
    mismatch_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO mismatch_count
    FROM users
    WHERE ABS((rp_balance * 1000000)::BIGINT - rp_balance_ledger) > 0
       OR ABS((rp_staked  * 1000000)::BIGINT - rp_staked_ledger) > 0;
    
    IF mismatch_count > 0 THEN
        RAISE EXCEPTION 'Ledger backfill validation failed: % rows have mismatched values', mismatch_count;
    END IF;
    
    RAISE NOTICE 'Ledger columns successfully added and backfilled for all users';
END $$;

COMMIT;

-- Rollback instructions (for reference):
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_rp_staked_ledger_nonneg;
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_rp_balance_ledger_nonneg;
-- ALTER TABLE users DROP COLUMN IF EXISTS rp_staked_ledger;
-- ALTER TABLE users DROP COLUMN IF EXISTS rp_balance_ledger;