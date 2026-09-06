-- "Propose market" from a post: the submission remembers which post it came
-- from so the post can be linked to the approved market automatically.
ALTER TABLE market_question_submissions
ADD COLUMN IF NOT EXISTS source_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_market_question_submissions_source_post
  ON market_question_submissions (source_post_id)
  WHERE source_post_id IS NOT NULL;
