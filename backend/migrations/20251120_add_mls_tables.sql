-- OpenMLS Tables
-- Replaces the Signal Protocol tables if they exist

DROP TABLE IF EXISTS e2ee_one_time_prekeys;
DROP TABLE IF EXISTS e2ee_signed_prekeys;
DROP TABLE IF EXISTS e2ee_devices;

-- Store Key Packages (Public Identity + Initial Keys)
CREATE TABLE IF NOT EXISTS mls_key_packages (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL DEFAULT 'default',
  package_data BYTEA NOT NULL, -- The serialized KeyPackage
  hash TEXT NOT NULL, -- Unique identifier (hash of the package)
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id)
);

-- Store Welcome Messages (for offline group joining)
CREATE TABLE IF NOT EXISTS mls_welcome_messages (
  id SERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  receiver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data BYTEA NOT NULL, -- The encrypted Welcome message
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Store Group Messages (Commits, Proposals, Application Messages)
CREATE TABLE IF NOT EXISTS mls_group_messages (
  id SERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch INT NOT NULL, -- To ensure ordering
  content_type TEXT NOT NULL, -- 'application', 'commit', 'proposal'
  data BYTEA NOT NULL, -- The encrypted MLSMessage
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mls_kp_user ON mls_key_packages(user_id);
CREATE INDEX IF NOT EXISTS idx_mls_welcome_receiver ON mls_welcome_messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_mls_messages_group ON mls_group_messages(group_id, epoch);
