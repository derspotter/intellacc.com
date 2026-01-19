-- Track password change timestamps for JWT invalidation
ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP DEFAULT NOW();
