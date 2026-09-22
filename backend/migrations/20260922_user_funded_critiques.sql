-- Public reviews are opt-in and use the author's saved credential.
ALTER TABLE user_post_critique_settings DROP CONSTRAINT IF EXISTS user_post_critique_settings_model_check;
ALTER TABLE user_post_critique_settings ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_post_critique_settings ALTER COLUMN model SET DEFAULT '';
CREATE TABLE IF NOT EXISTS ai_post_critique_requests (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id,content_hash,provider,model)
);
