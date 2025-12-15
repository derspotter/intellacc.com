-- Add mls_groups and mls_group_members tables
-- Required for Step 4 of E2EE implementation

CREATE TABLE IF NOT EXISTS mls_groups (
    group_id TEXT PRIMARY KEY, -- The MLS Group ID (hex encoded or UUID)
    name VARCHAR(255),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mls_group_members (
    group_id TEXT REFERENCES mls_groups(group_id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mls_groups_created_by ON mls_groups(created_by);
CREATE INDEX IF NOT EXISTS idx_mls_group_members_user ON mls_group_members(user_id);
