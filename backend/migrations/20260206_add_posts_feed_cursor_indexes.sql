-- Speed up cursor pagination for home feed and posts list.
-- Uses (created_at, id) ordering.

CREATE INDEX IF NOT EXISTS idx_posts_created_at_id_desc
  ON posts (created_at DESC, id DESC);

-- Most feed queries only include top-level posts.
CREATE INDEX IF NOT EXISTS idx_posts_top_level_created_at_id_desc
  ON posts (created_at DESC, id DESC)
  WHERE parent_id IS NULL AND is_comment = FALSE;

