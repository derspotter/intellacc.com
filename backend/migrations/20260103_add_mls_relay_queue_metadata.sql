ALTER TABLE mls_relay_queue
  ADD COLUMN IF NOT EXISTS group_info BYTEA,
  ADD COLUMN IF NOT EXISTS epoch BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_commit_epoch
  ON mls_relay_queue (group_id, epoch)
  WHERE message_type = 'commit';
