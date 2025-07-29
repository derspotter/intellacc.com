-- 008_add_messaging_system.sql
-- Database migration for end-to-end encrypted messaging system
-- Creates tables for conversations, messages, and user encryption keys

-- User encryption keys table
-- Stores public keys for each user for end-to-end encryption
CREATE TABLE IF NOT EXISTS user_keys (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL, -- Base64 encoded RSA public key
    key_fingerprint VARCHAR(64) NOT NULL, -- SHA-256 hash of public key for verification
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for key lookups
CREATE INDEX IF NOT EXISTS idx_user_keys_fingerprint ON user_keys(key_fingerprint);

-- Conversations table
-- Represents a conversation between two users
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    participant_1 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    participant_2 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure participant_1 is always the smaller user ID for consistency
    CONSTRAINT check_participant_order CHECK (participant_1 < participant_2),
    -- Ensure unique conversation between two users
    UNIQUE(participant_1, participant_2)
);

-- Create indexes for conversation queries
CREATE INDEX IF NOT EXISTS idx_conversations_participant_1 ON conversations(participant_1);
CREATE INDEX IF NOT EXISTS idx_conversations_participant_2 ON conversations(participant_2);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);

-- Messages table
-- Stores encrypted messages within conversations
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Encrypted content using recipient's public key
    encrypted_content TEXT NOT NULL, -- Base64 encoded encrypted message
    
    -- Message metadata
    message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'file')),
    
    -- Session key encrypted for each participant (for perfect forward secrecy)
    sender_session_key TEXT, -- Session key encrypted with sender's public key
    receiver_session_key TEXT, -- Session key encrypted with receiver's public key
    
    -- Message authentication
    content_hash VARCHAR(64) NOT NULL, -- SHA-256 hash of original content for integrity
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    read_at TIMESTAMP WITH TIME ZONE, -- When message was read by receiver
    
    -- Soft delete for message history
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for message queries
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_not_deleted ON messages(conversation_id) WHERE deleted_at IS NULL;

-- Message delivery status table
-- Tracks message delivery for real-time features
CREATE TABLE IF NOT EXISTS message_delivery (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    delivered_at TIMESTAMP WITH TIME ZONE, -- When message was delivered via socket
    delivery_attempts INTEGER DEFAULT 0, -- Number of delivery attempts
    last_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create trigger to update conversation last_message_at
CREATE OR REPLACE FUNCTION update_conversation_last_message()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE conversations 
    SET last_message_at = NEW.created_at,
        updated_at = NEW.created_at
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_message_insert
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_conversation_last_message();

-- Create trigger to update user_keys updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_keys_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_keys_update_timestamp
    BEFORE UPDATE ON user_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_user_keys_timestamp();

-- Create view for conversation summaries with participant info
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
LEFT JOIN messages m ON c.id = m.conversation_id 
    AND m.created_at = c.last_message_at
    AND m.deleted_at IS NULL
ORDER BY c.last_message_at DESC;

-- Function to get or create conversation between two users
CREATE OR REPLACE FUNCTION get_or_create_conversation(user1_id INTEGER, user2_id INTEGER)
RETURNS INTEGER AS $$
DECLARE
    conversation_id INTEGER;
    smaller_id INTEGER;
    larger_id INTEGER;
BEGIN
    -- Ensure consistent ordering (smaller ID first)
    IF user1_id < user2_id THEN
        smaller_id := user1_id;
        larger_id := user2_id;
    ELSE
        smaller_id := user2_id;
        larger_id := user1_id;
    END IF;
    
    -- Try to find existing conversation
    SELECT id INTO conversation_id
    FROM conversations
    WHERE participant_1 = smaller_id AND participant_2 = larger_id;
    
    -- If not found, create new conversation
    IF conversation_id IS NULL THEN
        INSERT INTO conversations (participant_1, participant_2)
        VALUES (smaller_id, larger_id)
        RETURNING id INTO conversation_id;
    END IF;
    
    RETURN conversation_id;
END;
$$ LANGUAGE plpgsql;

-- Add constraints to prevent users from messaging themselves
ALTER TABLE conversations ADD CONSTRAINT check_no_self_conversation 
    CHECK (participant_1 != participant_2);

ALTER TABLE messages ADD CONSTRAINT check_no_self_message 
    CHECK (sender_id != receiver_id);

-- Create notification types for messaging in notifications table
-- Update the existing notification type constraint to include message types
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check 
    CHECK (type IN ('like', 'comment', 'follow', 'mention', 'reply', 'message', 'message_read'));