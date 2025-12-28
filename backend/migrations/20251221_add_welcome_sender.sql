-- Add sender_id to Welcome messages for trust verification
-- This enables recipients to know WHO invited them

ALTER TABLE mls_welcome_messages
ADD COLUMN IF NOT EXISTS sender_id INT REFERENCES users(id) ON DELETE CASCADE;

-- Create index for sender lookups
CREATE INDEX IF NOT EXISTS idx_mls_welcome_sender ON mls_welcome_messages(sender_id);
