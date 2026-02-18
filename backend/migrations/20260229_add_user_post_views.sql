-- 2026-02-29: Track user-post views for seen-post search
-- Introduced for scope=seen post search with 90-day retention filtering.

BEGIN;

CREATE TABLE IF NOT EXISTS user_post_views (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_user_post_views_user_seen_at
  ON user_post_views (user_id, seen_at DESC, post_id DESC);

COMMIT;
