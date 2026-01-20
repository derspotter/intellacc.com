-- ============================================
-- MLS User Data Cleanup Script
-- ============================================
-- Usage: Replace $USER_ID with the actual user ID
--
-- Example: To clear user 3 (alice):
--   docker exec intellacc_db psql -U intellacc_user -d intellaccdb -f /path/to/this/file
--
-- Or run inline:
--   docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "
--     DELETE FROM mls_welcome_messages WHERE receiver_id = 3 OR sender_id = 3;
--     DELETE FROM mls_group_messages WHERE sender_id = 3;
--     DELETE FROM mls_key_packages WHERE user_id = 3;
--     DELETE FROM mls_group_members WHERE user_id = 3;
--     DELETE FROM mls_direct_messages WHERE user_a_id = 3 OR user_b_id = 3;
--   "
-- ============================================

-- Function to clear all MLS data for a specific user
DROP FUNCTION IF EXISTS clear_user_mls_data(INTEGER);
CREATE OR REPLACE FUNCTION clear_user_mls_data(target_user_id INTEGER)
RETURNS TABLE(table_name TEXT, deleted_count BIGINT) AS $$
DECLARE
    user_groups TEXT[];
BEGIN
    -- Get all groups the user is a member of (for message cleanup)
    SELECT ARRAY_AGG(group_id) INTO user_groups
    FROM mls_group_members WHERE user_id = target_user_id;

    -- Delete welcome messages (sent or received)
    DELETE FROM mls_welcome_messages
    WHERE receiver_id = target_user_id OR sender_id = target_user_id;
    RETURN QUERY SELECT 'mls_welcome_messages'::TEXT, (SELECT count(*) FROM mls_welcome_messages WHERE receiver_id = target_user_id OR sender_id = target_user_id);

    -- Delete group messages sent by user
    DELETE FROM mls_group_messages WHERE sender_id = target_user_id;

    -- Delete key packages
    DELETE FROM mls_key_packages WHERE user_id = target_user_id;

    -- Delete group memberships
    DELETE FROM mls_group_members WHERE user_id = target_user_id;

    -- Delete DMs involving user
    DELETE FROM mls_direct_messages
    WHERE user_a_id = target_user_id OR user_b_id = target_user_id;

    -- Return summary
    RETURN QUERY
    SELECT 'cleared'::TEXT, target_user_id::BIGINT;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- QUICK REFERENCE - Copy/paste commands:
-- ============================================
--
-- Clear Alice (user 3):
-- docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT clear_user_mls_data(3);"
--
-- Clear Bob (user 4):
-- docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT clear_user_mls_data(4);"
--
-- Clear ALL MLS data (nuclear option):
-- docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "
--   TRUNCATE mls_welcome_messages, mls_group_messages, mls_key_packages,
--            mls_group_members, mls_direct_messages, mls_groups CASCADE;
-- "
--
-- ============================================
-- FRONTEND (run in browser console):
-- ============================================
--
-- indexedDB.deleteDatabase('intellacc_keystore');
-- location.reload();
--
-- ============================================
