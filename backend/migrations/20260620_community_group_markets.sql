CREATE TABLE IF NOT EXISTS community_group_markets (
  group_id  INT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
  event_id  INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  pinned_by INT REFERENCES users(id) ON DELETE SET NULL,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_cgmarkets_group ON community_group_markets (group_id, pinned_at DESC);
