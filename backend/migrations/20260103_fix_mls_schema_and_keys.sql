-- Fix MLS Schema and Add Master Keys
-- Date: 2026-01-03

-- 1. Ensure Relay Queue tables exist (if not already created manually)
CREATE TABLE IF NOT EXISTS mls_relay_queue (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender_device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL, -- 'application', 'commit', 'welcome'
  data BYTEA NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITHOUT TIME ZONE DEFAULT (NOW() + INTERVAL '30 days'),
  group_info BYTEA,
  epoch BIGINT
);

CREATE INDEX IF NOT EXISTS idx_relay_expires ON mls_relay_queue(expires_at);

-- Drop the unique constraint if it exists (caused 500 errors)
DROP INDEX IF EXISTS idx_mls_commit_epoch;

CREATE TABLE IF NOT EXISTS mls_relay_recipients (
  queue_id BIGINT NOT NULL REFERENCES mls_relay_queue(id) ON DELETE CASCADE,
  recipient_device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  acked_at TIMESTAMP WITHOUT TIME ZONE,
  PRIMARY KEY (queue_id, recipient_device_id)
);

CREATE INDEX IF NOT EXISTS idx_relay_recipient ON mls_relay_recipients(recipient_device_id) WHERE acked_at IS NULL;

-- 2. Add Master Keys table (Architecture V6/V8)
CREATE TABLE IF NOT EXISTS user_master_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key TEXT,         -- Password-wrapped Master Key
  salt TEXT,
  iv TEXT,
  wrapped_key_prf TEXT,     -- PRF-wrapped Master Key (WebAuthn)
  salt_prf TEXT,
  iv_prf TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. Add Verification tracking to User Devices (Architecture V7)
ALTER TABLE user_devices 
ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMP DEFAULT NOW();
