ALTER TABLE users
ADD COLUMN IF NOT EXISTS ui_skin_preference TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_users_ui_skin_preference'
  ) THEN
    ALTER TABLE users
    ADD CONSTRAINT chk_users_ui_skin_preference
    CHECK (ui_skin_preference IN ('van', 'terminal'));
  END IF;
END $$;

