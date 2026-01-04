ALTER TABLE mls_relay_queue
  ADD COLUMN IF NOT EXISTS group_info bytea;
