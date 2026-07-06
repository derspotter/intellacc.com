-- 2026-07-05: Multi-outcome market creation via the community question pipeline.
ALTER TABLE market_question_submissions
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(20) NOT NULL DEFAULT 'binary',
  ADD COLUMN IF NOT EXISTS outcome_rows JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'market_question_submissions_event_type_check'
  ) THEN
    ALTER TABLE market_question_submissions
      ADD CONSTRAINT market_question_submissions_event_type_check
      CHECK (event_type IN ('binary', 'multiple_choice', 'numeric'));
  END IF;
END $$;
