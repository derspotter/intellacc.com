ALTER TABLE mls_credential_requests
  ADD COLUMN IF NOT EXISTS response_bytes BYTEA,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_mls_credential_requests_expires
  ON mls_credential_requests(expires_at);
