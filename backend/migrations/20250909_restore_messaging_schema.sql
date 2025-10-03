-- 20250909_restore_messaging_schema.sql
-- Restore/ensure messaging tables and related helpers for encrypted messaging feature

BEGIN;

-- Ensure user_keys table exists for E2EE public keys
CREATE TABLE IF NOT EXISTS user_keys (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    key_fingerprint VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_keys_fingerprint ON user_keys(key_fingerprint);

-- Refresh notifications type constraint to include messaging-related entries
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('like', 'comment', 'follow', 'mention', 'reply', 'message', 'message_read'));

-- Conversations table between two participants
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    participant_1 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    participant_2 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_unique_pair
    ON conversations(LEAST(participant_1, participant_2), GREATEST(participant_1, participant_2));

CREATE INDEX IF NOT EXISTS idx_conversations_participant_1 ON conversations(participant_1);
CREATE INDEX IF NOT EXISTS idx_conversations_participant_2 ON conversations(participant_2);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);

-- Enforce participant ordering and disallow self-conversations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'check_participant_order' AND conrelid = 'conversations'::regclass
    ) THEN
        ALTER TABLE conversations
            ADD CONSTRAINT check_participant_order CHECK (participant_1 < participant_2);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'check_no_self_conversation' AND conrelid = 'conversations'::regclass
    ) THEN
        ALTER TABLE conversations
            ADD CONSTRAINT check_no_self_conversation CHECK (participant_1 != participant_2);
    END IF;
END
$$;

-- Ensure last_message_id column exists (added in later optimization pass)
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS last_message_id INTEGER;

-- Messages table storing encrypted payloads
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'file')),
    sender_session_key TEXT,
    receiver_session_key TEXT,
    content_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    read_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Messaging constraints (no self messaging + payload length)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'check_no_self_message' AND conrelid = 'messages'::regclass
    ) THEN
        ALTER TABLE messages
            ADD CONSTRAINT check_no_self_message CHECK (sender_id != receiver_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'encrypted_content_max_len' AND conrelid = 'messages'::regclass
    ) THEN
        ALTER TABLE messages
            ADD CONSTRAINT encrypted_content_max_len
                CHECK (char_length(encrypted_content) <= 24576);
    END IF;
END
$$;

-- Message indexes to support queries
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_not_deleted ON messages(conversation_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_unread_conv ON messages(receiver_id, conversation_id) WHERE read_at IS NULL;

-- Establish last_message_id foreign key after messages table exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'conversations' AND column_name = 'last_message_id'
    ) THEN
        BEGIN
            ALTER TABLE conversations
                ADD CONSTRAINT conversations_last_message_fk
                FOREIGN KEY (last_message_id) REFERENCES messages(id)
                ON DELETE SET NULL;
        EXCEPTION
            WHEN duplicate_object THEN
                -- constraint already present
                NULL;
        END;
    END IF;
END
$$;

-- Backfill last_message_id for any existing conversation rows
UPDATE conversations c
SET last_message_id = sub.id
FROM (
    SELECT DISTINCT ON (m.conversation_id)
        m.conversation_id,
        m.id
    FROM messages m
    WHERE m.deleted_at IS NULL
    ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
) sub
WHERE c.id = sub.conversation_id;

-- Message delivery tracking (best-effort)
CREATE TABLE IF NOT EXISTS message_delivery (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    delivery_attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Prefer unlogged table for delivery bookkeeping if empty (matches original design)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'message_delivery') THEN
        IF (SELECT COUNT(*) = 0 FROM message_delivery) THEN
            ALTER TABLE message_delivery SET UNLOGGED;
        END IF;
    END IF;
END
$$;

-- Trigger to keep conversation timestamps and last message reference in sync
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

DROP TRIGGER IF EXISTS after_message_insert ON messages;
CREATE TRIGGER after_message_insert
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_conversation_last_message();

-- Function to fetch or create canonical conversation pair
CREATE OR REPLACE FUNCTION get_or_create_conversation(user1_id INTEGER, user2_id INTEGER)
RETURNS INTEGER AS $$
DECLARE
    conversation_id INTEGER;
    smaller_id INTEGER;
    larger_id INTEGER;
BEGIN
    IF user1_id < user2_id THEN
        smaller_id := user1_id;
        larger_id := user2_id;
    ELSE
        smaller_id := user2_id;
        larger_id := user1_id;
    END IF;

    SELECT id INTO conversation_id
    FROM conversations
    WHERE participant_1 = smaller_id AND participant_2 = larger_id;

    IF conversation_id IS NULL THEN
        INSERT INTO conversations (participant_1, participant_2)
        VALUES (smaller_id, larger_id)
        RETURNING id INTO conversation_id;
    END IF;

    RETURN conversation_id;
END;
$$ LANGUAGE plpgsql;

-- View for conversation summaries (latest message + unread counts)
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
    lm.encrypted_content AS last_message_encrypted,
    lm.sender_id AS last_message_sender_id,
    lm.created_at AS last_message_created_at,
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

COMMIT;
