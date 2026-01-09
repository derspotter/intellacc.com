-- Migration to support staged login flow with pre-login device verification
-- Date: 2026-01-09

-- Pre-login link requests for unauthenticated device verification
-- This is separate from device_linking_tokens because:
-- 1. We don't have user_id yet (user hasn't logged in)
-- 2. We use email instead to look up the user
-- 3. We need to handle non-existent emails gracefully (anti-enumeration)
CREATE TABLE IF NOT EXISTS pre_login_link_requests (
  id SERIAL PRIMARY KEY,
  session_token UUID NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL,
  device_fingerprint VARCHAR(255),
  verification_code VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, approved, expired
  device_public_id UUID, -- Set when approved
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pre_login_link_session ON pre_login_link_requests(session_token);
CREATE INDEX IF NOT EXISTS idx_pre_login_link_email ON pre_login_link_requests(email);
CREATE INDEX IF NOT EXISTS idx_pre_login_link_code ON pre_login_link_requests(verification_code);
CREATE INDEX IF NOT EXISTS idx_pre_login_link_expires ON pre_login_link_requests(expires_at);

-- Cleanup job for expired requests (optional - can be run periodically)
-- DELETE FROM pre_login_link_requests WHERE expires_at < NOW() - INTERVAL '1 day';
