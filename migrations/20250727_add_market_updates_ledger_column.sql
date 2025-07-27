-- 2025-07-27: Add stake_amount_ledger to market_updates for true invariant verification
-- Enables proper ledger-based balance conservation proof

BEGIN;

-- Add ledger column for precise stake tracking
ALTER TABLE market_updates
  ADD COLUMN IF NOT EXISTS stake_amount_ledger BIGINT NOT NULL DEFAULT 0;

-- Backfill from existing NUMERIC values
-- Convert stake_amount to ledger units (multiply by 1,000,000)
UPDATE market_updates
SET stake_amount_ledger = (stake_amount * 1000000)::BIGINT
WHERE stake_amount_ledger = 0;

-- Add safety constraint
ALTER TABLE market_updates
  ADD CONSTRAINT chk_stake_amount_ledger_nonneg CHECK (stake_amount_ledger >= 0);

-- Verify backfill worked correctly
DO $$
DECLARE
    mismatch_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO mismatch_count
    FROM market_updates
    WHERE ABS((stake_amount * 1000000)::BIGINT - stake_amount_ledger) > 0;
    
    IF mismatch_count > 0 THEN
        RAISE EXCEPTION 'Ledger backfill validation failed: % rows have mismatched values', mismatch_count;
    END IF;
    
    RAISE NOTICE 'Market updates ledger column successfully added and backfilled';
END $$;

COMMIT;

-- Rollback instructions (for reference):
-- ALTER TABLE market_updates DROP CONSTRAINT IF EXISTS chk_stake_amount_ledger_nonneg;
-- ALTER TABLE market_updates DROP COLUMN IF EXISTS stake_amount_ledger;