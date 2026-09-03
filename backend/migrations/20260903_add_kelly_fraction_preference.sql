-- Per-account stake-sizing preference: fraction of full Kelly the trade
-- ticket auto-fills (¼ / ½ / 1×). NULL = client default (0.25).
ALTER TABLE users
ADD COLUMN IF NOT EXISTS kelly_fraction_preference DOUBLE PRECISION;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_kelly_fraction_preference'
  ) THEN
    ALTER TABLE users
    ADD CONSTRAINT chk_users_kelly_fraction_preference
    CHECK (kelly_fraction_preference IN (0.25, 0.5, 1.0));
  END IF;
END $$;
