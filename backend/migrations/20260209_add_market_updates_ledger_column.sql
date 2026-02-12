-- 2026-02-09: Add stake_amount_ledger to market_updates (missing from backend/migrations)
-- Enables ledger-based stake accounting used by weekly assignment logic/tests.

BEGIN;

ALTER TABLE market_updates
  ADD COLUMN IF NOT EXISTS stake_amount_ledger BIGINT NOT NULL DEFAULT 0;

-- Backfill from existing NUMERIC values (ledger units = stake_amount * 1,000,000).
UPDATE market_updates
SET stake_amount_ledger = (stake_amount * 1000000)::BIGINT
WHERE stake_amount_ledger = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_stake_amount_ledger_nonneg'
  ) THEN
    ALTER TABLE market_updates
      ADD CONSTRAINT chk_stake_amount_ledger_nonneg CHECK (stake_amount_ledger >= 0);
  END IF;
END $$;

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
END $$;

COMMIT;

