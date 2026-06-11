ALTER TABLE users
ADD COLUMN IF NOT EXISTS display_name TEXT,
ADD COLUMN IF NOT EXISTS profile_visibility VARCHAR(32) NOT NULL DEFAULT 'public';

UPDATE users
SET profile_visibility = 'public'
WHERE profile_visibility IS NULL;

ALTER TABLE users
DROP CONSTRAINT IF EXISTS users_profile_visibility_check;

ALTER TABLE users
ADD CONSTRAINT users_profile_visibility_check
CHECK (profile_visibility IN ('public', 'followers_only', 'private'));
