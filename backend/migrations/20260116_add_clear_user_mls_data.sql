-- MLS user data cleanup helper
-- Drop existing function if it exists with a different return type
DROP FUNCTION IF EXISTS clear_user_mls_data(INTEGER);
CREATE OR REPLACE FUNCTION clear_user_mls_data(target_user_id INTEGER)
RETURNS VOID AS $$
BEGIN
  DELETE FROM mls_welcome_messages
  WHERE receiver_id = target_user_id OR sender_id = target_user_id;

  DELETE FROM mls_group_messages
  WHERE sender_id = target_user_id;

  DELETE FROM mls_key_packages
  WHERE user_id = target_user_id;

  DELETE FROM mls_group_members
  WHERE user_id = target_user_id;

  DELETE FROM mls_direct_messages
  WHERE user_a_id = target_user_id OR user_b_id = target_user_id;
END;
$$ LANGUAGE plpgsql;
