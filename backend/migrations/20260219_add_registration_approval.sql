-- Registration approval workflow

-- Track whether a newly created account is approved to log in.
ALTER TABLE users
ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

UPDATE users
SET is_approved = TRUE
WHERE is_approved IS NULL;

-- Approval links for admin triage.
CREATE TABLE IF NOT EXISTS registration_approval_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    approver_email VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT chk_registration_approval_token_status
      CHECK (status IN ('pending', 'approved', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_registration_approval_tokens_user
  ON registration_approval_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_registration_approval_tokens_status
  ON registration_approval_tokens (status);
