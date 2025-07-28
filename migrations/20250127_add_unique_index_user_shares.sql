-- 2025-01-27: Add unique index on user_shares(user_id, event_id)
-- Ensures ON CONFLICT operations work correctly and prevents duplicate user/event pairs

BEGIN;

-- Add unique index if it doesn't already exist
-- This supports the ON CONFLICT (user_id, event_id) operations used throughout the codebase
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_shares_user_event_unique 
ON user_shares (user_id, event_id);

-- Verify the index was created
DO $$
DECLARE
    index_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'user_shares' 
        AND indexname = 'idx_user_shares_user_event_unique'
    ) INTO index_exists;
    
    IF NOT index_exists THEN
        RAISE EXCEPTION 'Failed to create unique index on user_shares(user_id, event_id)';
    END IF;
    
    RAISE NOTICE 'Unique index on user_shares(user_id, event_id) created successfully';
END $$;

COMMIT;

-- Verification query (run separately to check results)
/*
-- Check for any duplicate user_id, event_id pairs that would violate the constraint
SELECT user_id, event_id, COUNT(*) as duplicate_count
FROM user_shares
GROUP BY user_id, event_id
HAVING COUNT(*) > 1;

-- Verify the index exists
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'user_shares' 
AND indexname = 'idx_user_shares_user_event_unique';
*/