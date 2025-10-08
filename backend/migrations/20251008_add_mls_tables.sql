-- Create table for storing uploaded MLS key packages per client/ciphersuite
CREATE TABLE IF NOT EXISTS mls_key_packages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  ciphersuite INTEGER NOT NULL,
  credential_type TEXT NOT NULL,
  key_package BYTEA NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mls_key_packages_user ON mls_key_packages(user_id);
CREATE INDEX IF NOT EXISTS idx_mls_key_packages_client ON mls_key_packages(client_id);
CREATE INDEX IF NOT EXISTS idx_mls_key_packages_cipher ON mls_key_packages(ciphersuite);

-- Persist commit bundles (including optional welcome/group info/application message)
CREATE TABLE IF NOT EXISTS mls_commit_bundles (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_client_id TEXT NOT NULL,
  commit_bundle BYTEA NOT NULL,
  welcome BYTEA NULL,
  group_info BYTEA NULL,
  encrypted_message BYTEA NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mls_commit_bundles_conversation ON mls_commit_bundles(conversation_id);

-- Store plain MLS application messages for recovery/backfill
CREATE TABLE IF NOT EXISTS mls_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_client_id TEXT NOT NULL,
  epoch INTEGER NULL,
  ciphertext BYTEA NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mls_messages_conversation ON mls_messages(conversation_id);
