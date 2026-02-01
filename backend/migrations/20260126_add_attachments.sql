BEGIN;

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope VARCHAR(20) NOT NULL,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  mls_group_id TEXT REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  content_type VARCHAR(100) NOT NULL,
  size BIGINT NOT NULL,
  sha256 VARCHAR(64),
  storage_path TEXT NOT NULL,
  original_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attachments_scope_check CHECK (
    (scope = 'post' AND mls_group_id IS NULL) OR
    (scope = 'message' AND post_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_id);
CREATE INDEX IF NOT EXISTS idx_attachments_post ON attachments(post_id);
CREATE INDEX IF NOT EXISTS idx_attachments_mls_group ON attachments(mls_group_id);

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS image_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL;

COMMIT;
