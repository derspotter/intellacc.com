-- Sub-project B: a post may belong to one community group (NULL = global post).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS community_group_id INT REFERENCES community_groups(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_posts_community_group ON posts (community_group_id, created_at DESC) WHERE community_group_id IS NOT NULL;
