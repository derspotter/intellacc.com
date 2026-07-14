-- Numeric distribution trading schema: per-event binning config, distribution
-- trades (vector buys/full-position sells), and per-outcome trade legs.
-- Idempotent: safe to replay.

CREATE TABLE IF NOT EXISTS numeric_market_config (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  range_min DOUBLE PRECISION NOT NULL,
  range_max DOUBLE PRECISION NOT NULL,
  zero_point DOUBLE PRECISION,
  open_lower_bound BOOLEAN NOT NULL DEFAULT FALSE,
  open_upper_bound BOOLEAN NOT NULL DEFAULT FALSE,
  unit TEXT,
  bin_count INTEGER NOT NULL,
  transform TEXT NOT NULL DEFAULT 'linear',
  binning_version INTEGER NOT NULL DEFAULT 1,
  b_numeric DOUBLE PRECISION NOT NULL,
  numeric_market_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS distribution_trades (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  total_cost_ledger BIGINT NOT NULL,          -- signed; negative = sale credit
  alpha DOUBLE PRECISION,                      -- NULL for full-position sells
  target_distribution JSONB,                   -- NULL for sells
  pre_market_version BIGINT NOT NULL,
  post_market_version BIGINT NOT NULL,
  hold_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_distribution_trades_event ON distribution_trades(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_distribution_trades_user ON distribution_trades(user_id);
CREATE TABLE IF NOT EXISTS distribution_trade_legs (
  trade_id BIGINT NOT NULL REFERENCES distribution_trades(id) ON DELETE CASCADE,
  outcome_id BIGINT NOT NULL REFERENCES event_outcomes(id) ON DELETE CASCADE,
  shares_delta DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (trade_id, outcome_id)
);
