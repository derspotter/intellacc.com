-- Device verification must be an explicit trust event.
-- The earlier MLS schema migration set last_verified_at DEFAULT NOW(), which
-- makes accidental or auxiliary device inserts trusted by default.

ALTER TABLE user_devices
  ALTER COLUMN last_verified_at DROP DEFAULT;
