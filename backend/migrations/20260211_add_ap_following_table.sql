-- Outbound ActivityPub follows initiated by local users.

CREATE TABLE IF NOT EXISTS ap_following (
  id SERIAL PRIMARY KEY,
  follower_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_uri TEXT NOT NULL,
  follow_activity_uri TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (follower_user_id, actor_uri)
);

CREATE INDEX IF NOT EXISTS idx_ap_following_follower_user_id
  ON ap_following(follower_user_id);

CREATE INDEX IF NOT EXISTS idx_ap_following_actor_uri
  ON ap_following(actor_uri);
