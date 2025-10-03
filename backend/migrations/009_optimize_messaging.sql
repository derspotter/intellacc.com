-- 009_optimize_messaging.sql
-- Performance and clarity improvements for messaging

BEGIN;

-- 1) Add last_message_id to conversations for deterministic, fast join
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_id INTEGER;

ALTER TABLE conversations
  ADD CONSTRAINT IF NOT EXISTS conversations_last_message_fk
  FOREIGN KEY (last_message_id) REFERENCES messages(id)
  ON DELETE SET NULL;

-- 2) Backfill last_message_id from current data
UPDATE conversations c
SET last_message_id = sub.id
FROM (
  SELECT m1.conversation_id, m1.id
  FROM messages m1
  WHERE m1.deleted_at IS NULL
  AND m1.created_at = (
    SELECT max(m2.created_at)
    FROM messages m2
    WHERE m2.conversation_id = m1.conversation_id AND m2.deleted_at IS NULL
  )
) AS sub
WHERE c.id = sub.conversation_id;

-- 3) Update trigger to set both last_message_at and last_message_id on insert
CREATE OR REPLACE FUNCTION update_conversation_last_message()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE conversations 
    SET last_message_at = NEW.created_at,
        updated_at = NEW.created_at,
        last_message_id = NEW.id
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4) Recreate conversation_summaries view to join by last_message_id
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
    
    -- Latest message info
    m.encrypted_content AS last_message_encrypted,
    m.sender_id AS last_message_sender_id,
    m.created_at AS last_message_created_at,
    
    -- Unread message counts for each participant
    (SELECT COUNT(*) FROM messages 
     WHERE conversation_id = c.id 
     AND receiver_id = c.participant_1 
     AND read_at IS NULL 
     AND deleted_at IS NULL) AS unread_count_participant_1,
     
    (SELECT COUNT(*) FROM messages 
     WHERE conversation_id = c.id 
     AND receiver_id = c.participant_2 
     AND read_at IS NULL 
     AND deleted_at IS NULL) AS unread_count_participant_2

FROM conversations c
JOIN users u1 ON c.participant_1 = u1.id
JOIN users u2 ON c.participant_2 = u2.id
LEFT JOIN messages m ON m.id = c.last_message_id
ORDER BY c.last_message_at DESC;

-- 5) Improve unread count lookup with more selective partial index
CREATE INDEX IF NOT EXISTS idx_messages_unread_conv
  ON messages (receiver_id, conversation_id)
  WHERE read_at IS NULL;

-- 6) Reduce WAL for delivery tracking (best-effort table)
ALTER TABLE IF EXISTS message_delivery SET UNLOGGED;

COMMIT;

