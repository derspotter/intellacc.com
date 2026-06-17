-- Community Groups (sub-project A): user-created theme-groups under a parent
-- topic. Distinct from mls_groups (private E2EE chats).
CREATE TABLE IF NOT EXISTS community_groups (
  id           SERIAL PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  topic_id     INT NOT NULL REFERENCES topics(id),
  created_by   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_count INT NOT NULL DEFAULT 0,
  removed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_groups_topic ON community_groups (topic_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_community_groups_members ON community_groups (member_count DESC) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS community_group_members (
  group_id  INT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cgm_user ON community_group_members (user_id);
