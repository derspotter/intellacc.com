-- Track password change timestamps for JWT invalidation
-- Note: NULL means password has never been changed (all tokens valid)
-- Only set this when password is actually changed (not on user creation)
ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP DEFAULT NULL;
