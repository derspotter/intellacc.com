-- 20250907_fix_conversation_view.sql
-- Fix duplication in conversation_summaries view caused by joining on created_at
-- Use a LATERAL subquery to select exactly one latest message per conversation

CREATE OR REPLACE VIEW conversation_summaries AS
SELECT 
    c.id AS conversation_id,
    c.participant_1,
    c.participant_2,
    u1.username AS participant_1_username,
    u2.username AS participant_2_username,
    c.created_at,
    c.updated_at,
    c.last_message_at,

    -- Latest message info via lateral join (ties broken by id)
    lm.encrypted_content AS last_message_encrypted,
    lm.sender_id AS last_message_sender_id,
    lm.created_at AS last_message_created_at,

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
LEFT JOIN LATERAL (
    SELECT m.*
    FROM messages m
    WHERE m.conversation_id = c.id 
      AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
) lm ON TRUE
ORDER BY c.last_message_at DESC;

-- Note: This view replaces the previous LEFT JOIN on messages with equality on created_at,
-- which could return multiple rows when several messages share the same created_at timestamp.
-- The lateral join guarantees at most one last message row per conversation.

