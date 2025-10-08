-- Create table for storing MLS history secrets prepared for transport.
CREATE TABLE IF NOT EXISTS mls_history_secrets (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_client_id TEXT NOT NULL,
  epoch INTEGER NULL,
  secret BYTEA NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mls_history_secrets_conversation
  ON mls_history_secrets(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mls_history_secrets_epoch
  ON mls_history_secrets(conversation_id, epoch);

-- Track conversation encryption state and migration eligibility.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS encryption_mode TEXT NOT NULL DEFAULT 'mls';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS mls_migration_eligible BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE conversations SET encryption_mode = 'mls';
UPDATE conversations SET mls_migration_eligible = FALSE WHERE mls_migration_eligible IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_encryption_mode
  ON conversations(encryption_mode);

DROP VIEW IF EXISTS conversation_summaries;

CREATE VIEW conversation_summaries AS
SELECT 
    c.id AS conversation_id,
    c.participant_1,
    c.participant_2,
    u1.username AS participant_1_username,
    u2.username AS participant_2_username,
    c.created_at,
    c.updated_at,
    c.last_message_at,
    c.encryption_mode,
    c.mls_migration_eligible,
    mlm.ciphertext_b64 AS last_message_encrypted,
    mlm.sender_id AS last_message_sender_id,
    mlm.created_at AS last_message_created_at,
    mlm.epoch AS last_mls_epoch,
    mlm.sender_client_id AS last_mls_sender_client_id,
    mlm.created_at AS last_mls_created_at,
    0 AS unread_count_participant_1,
    0 AS unread_count_participant_2
FROM conversations c
JOIN users u1 ON c.participant_1 = u1.id
JOIN users u2 ON c.participant_2 = u2.id
LEFT JOIN LATERAL (
    SELECT 
      mm.user_id AS sender_id,
      mm.sender_client_id,
      mm.epoch,
      mm.created_at,
      encode(mm.ciphertext, 'base64') AS ciphertext_b64
    FROM mls_messages mm
    WHERE mm.conversation_id = c.id
    ORDER BY mm.created_at DESC, mm.id DESC
    LIMIT 1
) mlm ON TRUE
ORDER BY c.last_message_at DESC;
