#!/bin/bash
# Reset server-side state for E2E test users
# Usage: ./tests/e2e/reset-test-users.sh
#
# Test users:
#   24, 25: testuser1, testuser2 (seeded)
#   27, 28: alice_test, bob_test (manually registered)

docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "
-- Clear user devices
DELETE FROM user_devices WHERE user_id IN (24, 25, 27, 28);
-- Clear master keys
DELETE FROM user_master_keys WHERE user_id IN (24, 25, 27, 28);
-- Clear MLS key packages
DELETE FROM mls_key_packages WHERE user_id IN (24, 25, 27, 28);
-- Clear MLS groups created by test users
DELETE FROM mls_groups WHERE created_by IN (24, 25, 27, 28);
-- Show what was cleared
SELECT 'Reset complete for test users (24, 25, 27, 28)' as status;
"
