-- backend/migrations/20260209_add_federation_tables.sql
-- ActivityPub federation primitives (MVP)

CREATE TABLE IF NOT EXISTS ap_server_keys (
  id SERIAL PRIMARY KEY,
  private_key_pem TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cache of remote ActivityPub actors (public key + inbox endpoints).
CREATE TABLE IF NOT EXISTS ap_remote_actors (
  actor_uri TEXT PRIMARY KEY,
  inbox_url TEXT,
  shared_inbox_url TEXT,
  public_key_pem TEXT,
  etag TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ
);

-- Remote followers for a local user.
CREATE TABLE IF NOT EXISTS ap_followers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_uri TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('pending', 'accepted', 'blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, actor_uri)
);

CREATE INDEX IF NOT EXISTS idx_ap_followers_user_id ON ap_followers(user_id);
CREATE INDEX IF NOT EXISTS idx_ap_followers_actor_uri ON ap_followers(actor_uri);

-- Map local posts to ActivityPub object/activity URIs.
CREATE TABLE IF NOT EXISTS ap_object_map (
  post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  object_uri TEXT NOT NULL UNIQUE,
  activity_uri TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Outbound delivery queue (DB-backed async delivery + retries).
CREATE TABLE IF NOT EXISTS federation_delivery_queue (
  id BIGSERIAL PRIMARY KEY,
  protocol TEXT NOT NULL CHECK (protocol IN ('ap')),
  target_url TEXT NOT NULL,
  signing_key_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_federation_delivery_due
  ON federation_delivery_queue(status, next_attempt_at);

-- Inbound idempotency (avoid processing duplicate activities).
CREATE TABLE IF NOT EXISTS federation_inbox_dedupe (
  protocol TEXT NOT NULL CHECK (protocol IN ('ap')),
  remote_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (protocol, remote_id)
);

