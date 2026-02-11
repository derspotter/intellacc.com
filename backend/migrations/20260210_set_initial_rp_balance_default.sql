-- Set default starting balance for new users to 1000 RP (ledger units).
-- 1 RP = 1,000,000 micro-RP, so 1000 RP = 1,000,000,000.

BEGIN;

ALTER TABLE users
  ALTER COLUMN rp_balance_ledger SET DEFAULT 1000000000;

COMMIT;
