-- Registration approval links: store token for reliable resend/dedup.

ALTER TABLE registration_approval_tokens
ADD COLUMN IF NOT EXISTS token TEXT;

