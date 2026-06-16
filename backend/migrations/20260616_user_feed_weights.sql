-- Per-user home-feed ranking weights (Feed Mix). Four integers that must sum to
-- 100. Absence of a row = default chronological feed (opt-in on first save).
CREATE TABLE IF NOT EXISTS user_feed_weights (
  user_id     INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  w_accuracy  SMALLINT NOT NULL,
  w_followers SMALLINT NOT NULL,
  w_likes     SMALLINT NOT NULL,
  w_views     SMALLINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_feed_weights_sum CHECK (w_accuracy + w_followers + w_likes + w_views = 100),
  CONSTRAINT user_feed_weights_range CHECK (
    w_accuracy  BETWEEN 0 AND 100 AND
    w_followers BETWEEN 0 AND 100 AND
    w_likes     BETWEEN 0 AND 100 AND
    w_views     BETWEEN 0 AND 100
  )
);
