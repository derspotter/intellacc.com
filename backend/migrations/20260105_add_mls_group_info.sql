ALTER TABLE mls_groups
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS group_info BYTEA,
  ADD COLUMN IF NOT EXISTS group_info_epoch BIGINT,
  ADD COLUMN IF NOT EXISTS group_info_updated_at TIMESTAMP WITHOUT TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_mls_groups_public ON mls_groups(is_public) WHERE is_public = TRUE;
