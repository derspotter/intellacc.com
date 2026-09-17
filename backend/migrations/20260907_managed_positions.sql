CREATE TABLE IF NOT EXISTS managed_positions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  belief_prob DOUBLE PRECISION NOT NULL CHECK (belief_prob > 0 AND belief_prob < 1),
  kelly_fraction DOUBLE PRECISION NOT NULL CHECK (kelly_fraction IN (0.25, 0.5, 1)),
  status TEXT NOT NULL DEFAULT 'paused',
  last_error TEXT,
  last_trade_summary TEXT,
  last_checked_at TIMESTAMPTZ,
  last_rebalanced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS managed_positions_due_idx
  ON managed_positions (last_checked_at NULLS FIRST, user_id, event_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS managed_position_activity (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  belief_prob DOUBLE PRECISION NOT NULL,
  kelly_fraction DOUBLE PRECISION NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id, event_id) REFERENCES managed_positions(user_id, event_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS managed_position_activity_position_idx
  ON managed_position_activity (user_id, event_id, created_at DESC);
