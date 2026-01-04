-- Migration to support WebAuthn and Device Keystores
-- Date: 2026-01-02

-- WebAuthn credentials for logging into an account
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id BYTEA NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT[],
  supports_prf BOOLEAN DEFAULT FALSE,
  name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_used_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_webauthn_user_id ON webauthn_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_credential_id ON webauthn_credentials(credential_id);

-- Linked devices (messaging-capable clients)
CREATE TABLE IF NOT EXISTS user_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_public_id UUID NOT NULL UNIQUE, -- The stable ID used in client keystores
  name TEXT,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);

-- Device linking tokens (for Signal-like QR linking)
CREATE TABLE IF NOT EXISTS device_linking_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    device_public_id UUID NOT NULL,
    device_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    approved_at TIMESTAMP WITH TIME ZONE,
    approved_by_device_id INTEGER REFERENCES user_devices(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_device_linking_token ON device_linking_tokens(token);
CREATE INDEX IF NOT EXISTS idx_device_linking_user ON device_linking_tokens(user_id);
