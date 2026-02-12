-- AT Protocol OAuth account linkage + outbound publishing queue (MVP)

CREATE TABLE IF NOT EXISTS atproto_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  pds_url TEXT NOT NULL,
  did TEXT NOT NULL,
  handle TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Compatibility with earlier app-password schema iterations.
ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS pds_url TEXT;
ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS did TEXT;
ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS handle TEXT;
ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN;
ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS access_jwt_encrypted TEXT;
ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS refresh_jwt_encrypted TEXT;
ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMPTZ;

ALTER TABLE atproto_accounts ALTER COLUMN access_jwt_encrypted DROP NOT NULL;
ALTER TABLE atproto_accounts ALTER COLUMN refresh_jwt_encrypted DROP NOT NULL;

ALTER TABLE atproto_accounts ALTER COLUMN is_enabled SET DEFAULT TRUE;
ALTER TABLE atproto_accounts ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE atproto_accounts ALTER COLUMN updated_at SET DEFAULT NOW();

UPDATE atproto_accounts
SET is_enabled = TRUE
WHERE is_enabled IS NULL;

UPDATE atproto_accounts
SET pds_url = 'https://bsky.social'
WHERE pds_url IS NULL OR btrim(pds_url) = '';

UPDATE atproto_accounts
SET handle = did
WHERE (handle IS NULL OR btrim(handle) = '')
  AND did IS NOT NULL
  AND btrim(did) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_atproto_accounts_user_id ON atproto_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_atproto_accounts_did ON atproto_accounts(did);
CREATE INDEX IF NOT EXISTS idx_atproto_accounts_handle ON atproto_accounts(handle);

CREATE TABLE IF NOT EXISTS atproto_oauth_state (
  key TEXT PRIMARY KEY,
  state_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atproto_oauth_state_expires_at ON atproto_oauth_state(expires_at);

CREATE TABLE IF NOT EXISTS atproto_oauth_session (
  sub TEXT PRIMARY KEY,
  session_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS atproto_post_map (
  post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at_uri TEXT NOT NULL UNIQUE,
  at_cid TEXT,
  record_rkey TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atproto_post_map_user_id ON atproto_post_map(user_id);

CREATE TABLE IF NOT EXISTS atproto_delivery_queue (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('create_post')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, post_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_atproto_delivery_due
  ON atproto_delivery_queue(status, next_attempt_at);
