-- E2EE Signal key bundle tables (identity, signed prekeys, one-time prekeys)

CREATE TABLE IF NOT EXISTS e2ee_devices (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL DEFAULT 'default',
  identity_pub TEXT NOT NULL,
  signing_pub TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS e2ee_signed_prekeys (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL DEFAULT 'default',
  key_id INT NOT NULL,
  public_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NULL,
  PRIMARY KEY (user_id, device_id, key_id)
);

CREATE TABLE IF NOT EXISTS e2ee_one_time_prekeys (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL DEFAULT 'default',
  key_id INT NOT NULL,
  public_key TEXT NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  reserved BOOLEAN NOT NULL DEFAULT FALSE,
  used_at TIMESTAMP NULL,
  reserved_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_e2ee_devices_user ON e2ee_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_e2ee_sp_user ON e2ee_signed_prekeys(user_id, device_id);
CREATE INDEX IF NOT EXISTS idx_e2ee_otp_user ON e2ee_one_time_prekeys(user_id, device_id, used, reserved);

