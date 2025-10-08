CREATE TABLE IF NOT EXISTS mls_conversations (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphersuite INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  history_sharing_enabled BOOLEAN DEFAULT FALSE,
  group_info BYTEA NULL
);
