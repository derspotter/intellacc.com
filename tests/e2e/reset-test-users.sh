#!/bin/bash
# Reset server-side state for E2E test users
# Usage: ./tests/e2e/reset-test-users.sh
#
# Test users:
#   user1@example.com, user2@example.com (seeded)
#   alice_test@example.com, bob_test@example.com (manually registered)

PASSWORD='password123'

docker exec intellacc_db psql -U intellacc_user -d intellaccdb -v ON_ERROR_STOP=1 -c "
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO users (username, email, password_hash, created_at, updated_at)
VALUES
  ('testuser1', 'user1@example.com', crypt('$PASSWORD', gen_salt('bf')), NOW(), NOW()),
  ('testuser2', 'user2@example.com', crypt('$PASSWORD', gen_salt('bf')), NOW(), NOW()),
  ('alice_test', 'alice_test@example.com', crypt('$PASSWORD', gen_salt('bf')), NOW(), NOW()),
  ('bob_test', 'bob_test@example.com', crypt('$PASSWORD', gen_salt('bf')), NOW(), NOW())
ON CONFLICT (email) DO UPDATE
SET
  username = EXCLUDED.username,
  password_hash = EXCLUDED.password_hash,
  deleted_at = NULL,
  updated_at = NOW();

UPDATE users
SET
  verification_tier = 1,
  email_verified_at = NOW()
WHERE email IN (
  'user1@example.com',
  'user2@example.com',
  'alice_test@example.com',
  'bob_test@example.com'
);

CREATE TEMP TABLE tmp_test_user_ids AS
  SELECT id FROM users
  WHERE email IN (
    'user1@example.com',
    'user2@example.com',
    'alice_test@example.com',
    'bob_test@example.com'
  );

-- Reconcile rp_staked_ledger against actual open positions: past spec runs
-- deleted events without refunding, leaving orphaned staked RP.
UPDATE users u
SET
  rp_balance_ledger = rp_balance_ledger + (u.rp_staked_ledger - expected.total),
  rp_staked_ledger = expected.total
FROM (
  SELECT t.id,
    COALESCE((SELECT SUM(staked_yes_ledger + staked_no_ledger) FROM user_shares s WHERE s.user_id = t.id), 0)
    + COALESCE((SELECT SUM(staked_ledger) FROM user_outcome_shares o WHERE o.user_id = t.id), 0)
    + COALESCE((SELECT SUM(basis_ledger) FROM numeric_position_basis b WHERE b.user_id = t.id), 0) AS total
  FROM tmp_test_user_ids t
) expected
WHERE u.id = expected.id AND u.rp_staked_ledger > expected.total;

-- Clear device linking tokens FIRST (has FK to user_devices)
DELETE FROM device_linking_tokens WHERE user_id IN (SELECT id FROM tmp_test_user_ids);
-- Clear user devices
DELETE FROM user_devices WHERE user_id IN (SELECT id FROM tmp_test_user_ids);
-- Clear master keys
DELETE FROM user_master_keys WHERE user_id IN (SELECT id FROM tmp_test_user_ids);
-- Clear MLS key packages
DELETE FROM mls_key_packages WHERE user_id IN (SELECT id FROM tmp_test_user_ids);
-- Clear MLS groups created by test users
DELETE FROM mls_groups WHERE created_by IN (SELECT id FROM tmp_test_user_ids);

-- Show what was cleared
SELECT 'Reset complete for test users' as status, array_agg(id) as user_ids FROM tmp_test_user_ids;
"
