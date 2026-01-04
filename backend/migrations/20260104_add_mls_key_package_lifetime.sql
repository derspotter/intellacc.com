ALTER TABLE mls_key_packages
  ADD COLUMN IF NOT EXISTS not_before TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS not_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_last_resort BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE mls_key_packages DROP CONSTRAINT IF EXISTS mls_key_packages_pkey;
ALTER TABLE mls_key_packages ADD PRIMARY KEY (user_id, device_id, is_last_resort);

CREATE INDEX IF NOT EXISTS idx_mls_kp_user_device ON mls_key_packages(user_id, device_id);
CREATE INDEX IF NOT EXISTS idx_mls_kp_validity ON mls_key_packages(user_id, not_after);
