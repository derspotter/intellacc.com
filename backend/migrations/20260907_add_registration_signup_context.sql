-- Signup context for the admin approval email: client IP, user agent and the
-- looked-up AS number. Held ONLY while the request is pending — cleared on
-- approve / reject / expiry (see registrationApprovalService) so a breach
-- exposes at most the handful of accounts awaiting a decision.

ALTER TABLE registration_approval_tokens
  ADD COLUMN IF NOT EXISTS signup_ip INET,
  ADD COLUMN IF NOT EXISTS signup_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS signup_asn INTEGER;

-- "Reject" from the approval email deletes the never-approved account.
ALTER TABLE registration_approval_tokens
  DROP CONSTRAINT IF EXISTS chk_registration_approval_token_status;
ALTER TABLE registration_approval_tokens
  ADD CONSTRAINT chk_registration_approval_token_status
  CHECK (status IN ('pending', 'approved', 'rejected', 'expired'));

-- Same-network count for the email ("N other signups from this network today").
CREATE INDEX IF NOT EXISTS idx_registration_approval_tokens_asn_created
  ON registration_approval_tokens (signup_asn, created_at)
  WHERE signup_asn IS NOT NULL;
