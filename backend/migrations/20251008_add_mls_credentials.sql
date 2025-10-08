CREATE TABLE IF NOT EXISTS mls_credential_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  ciphersuite INTEGER NOT NULL,
  request_bytes BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_mls_credential_requests_user ON mls_credential_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_mls_credential_requests_client ON mls_credential_requests(client_id);
