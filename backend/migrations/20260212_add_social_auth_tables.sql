-- Social OAuth login identities (Bluesky/ATProto + Mastodon)

CREATE TABLE IF NOT EXISTS federated_auth_identities (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('atproto', 'mastodon')),
  subject TEXT NOT NULL,
  external_username TEXT,
  profile_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, subject),
  UNIQUE (provider, user_id)
);

CREATE INDEX IF NOT EXISTS idx_federated_auth_user_id ON federated_auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_federated_auth_provider ON federated_auth_identities(provider);

CREATE TABLE IF NOT EXISTS social_oauth_state (
  state_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_oauth_state_provider ON social_oauth_state(provider);
CREATE INDEX IF NOT EXISTS idx_social_oauth_state_expires_at ON social_oauth_state(expires_at);
