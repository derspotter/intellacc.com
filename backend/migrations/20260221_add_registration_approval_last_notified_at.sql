-- Track when the admin approval notification was last sent to avoid duplicate emails.

ALTER TABLE registration_approval_tokens
ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMP WITH TIME ZONE;

