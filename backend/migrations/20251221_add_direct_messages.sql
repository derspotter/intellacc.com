-- Migration: Add Direct Messages (DM) tracking table
-- Date: 2025-12-21
-- Description: Track 1-to-1 E2EE conversations separately from groups

-- Track DM conversations (links to mls_groups)
CREATE TABLE IF NOT EXISTS mls_direct_messages (
  id SERIAL PRIMARY KEY,
  group_id TEXT UNIQUE NOT NULL REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  user_a_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by INT REFERENCES users(id),
  -- Ensure user_a_id < user_b_id for deterministic matching
  CHECK (user_a_id < user_b_id),
  UNIQUE (user_a_id, user_b_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_dm_user_a ON mls_direct_messages(user_a_id);
CREATE INDEX IF NOT EXISTS idx_dm_user_b ON mls_direct_messages(user_b_id);
