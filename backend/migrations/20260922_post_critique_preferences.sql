CREATE TABLE IF NOT EXISTS user_post_critique_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (model IN ('anthropic/claude-opus-5.5', 'openai/gpt-6-luna', 'off')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE post_critiques ADD COLUMN IF NOT EXISTS model TEXT;
