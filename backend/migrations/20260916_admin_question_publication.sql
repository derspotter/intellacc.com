ALTER TABLE market_question_submissions
  ADD COLUMN IF NOT EXISTS admin_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS admin_reviewed_at TIMESTAMP;
