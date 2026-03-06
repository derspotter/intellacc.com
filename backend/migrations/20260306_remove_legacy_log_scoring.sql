-- Remove legacy log-loss reputation artifacts.
-- Intellacc reputation is the LMSR ledger: available + staked.

DROP INDEX IF EXISTS idx_predictions_log_loss;

ALTER TABLE predictions
  DROP COLUMN IF EXISTS raw_log_loss;

DROP TABLE IF EXISTS score_slices;
DROP TABLE IF EXISTS user_reputation;
