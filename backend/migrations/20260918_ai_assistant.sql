-- Personal bring-your-own-key AI assistant.
-- Additive only. See docs/ai-assistant.md.

-- Dedicated, non-login bot identity used to publish public @ai replies.
-- Looked up by system_bot_key, never by handle, so an existing user who happens
-- to own a similar username is never commandeered. The password hash is not a
-- bcrypt hash, so password login can never succeed for this row.
ALTER TABLE users ADD COLUMN IF NOT EXISTS system_bot_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_system_bot_key_unique
  ON users (system_bot_key) WHERE system_bot_key IS NOT NULL;

INSERT INTO users (username, email, password_hash, role, bio, is_approved, system_bot_key)
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = 'ai') THEN 'ai'
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = 'ai_assistant') THEN 'ai_assistant'
    ELSE 'ai_assistant_' || substr(md5(random()::text), 1, 8)
  END,
  'ai-assistant@system.intellacc.invalid',
  '!system-bot-no-login',
  'user',
  'Automated AI replies. Each reply is generated with the requesting user''s own model key.',
  TRUE,
  'ai_assistant'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE system_bot_key = 'ai_assistant');

-- Per-user provider settings. The API key is stored only as AES-256-GCM
-- ciphertext bound to the owning user id (AAD); key_hint is the last 4 chars.
CREATE TABLE IF NOT EXISTS user_ai_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'xai')),
  model TEXT NOT NULL DEFAULT '' CHECK (length(model) <= 128),
  key_ciphertext TEXT,
  key_hint TEXT,
  public_replies BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Private assistant conversations (plaintext at rest by design: the content is
-- sent to the user's chosen provider; this is NOT the MLS user-to-user store).
CREATE TABLE IF NOT EXISTS ai_conversations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  title TEXT,
  generation_request_id UUID,
  generation_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_conversations_owner_recent
  ON ai_conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('pending', 'ok', 'failed')),
  error_code TEXT,
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_order
  ON ai_messages (conversation_id, id);

-- Durable idempotency: one row per (conversation, client request id). A repeat
-- of a succeeded request replays the stored turn; a repeat of a failed or
-- in-flight request never triggers a second paid provider call.
CREATE TABLE IF NOT EXISTS ai_conversation_requests (
  conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  user_message_id INTEGER REFERENCES ai_messages(id) ON DELETE SET NULL,
  assistant_message_id INTEGER REFERENCES ai_messages(id) ON DELETE SET NULL,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, request_id)
);

-- Durable per-user rate budget across public replies, private chats and tests.
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'test')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_usage_events_user_recent
  ON ai_usage_events (user_id, created_at DESC);
ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS active_until TIMESTAMPTZ;

-- Public @ai reply jobs: exactly one per triggering post, claimed atomically,
-- published at most once (reply_post_id is unique). Crashed or ambiguous work
-- is marked failed instead of re-running the paid request.
CREATE TABLE IF NOT EXISTS ai_public_reply_jobs (
  post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  requester_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'published', 'failed', 'declined')),
  error_code TEXT,
  reply_post_id INTEGER UNIQUE REFERENCES posts(id) ON DELETE SET NULL,
  model TEXT,
  lease_id UUID,
  locked_until TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_public_reply_jobs_ready
  ON ai_public_reply_jobs (created_at) WHERE status IN ('queued', 'running');
