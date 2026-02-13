-- Community market question submission + validator review flow
-- Economic params are enforced in backend controller logic.

CREATE TABLE IF NOT EXISTS market_question_submissions (
  id SERIAL PRIMARY KEY,
  creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  details TEXT NOT NULL,
  category VARCHAR(100),
  closing_date TIMESTAMP NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  creator_bond_ledger BIGINT NOT NULL,
  required_validators INTEGER NOT NULL DEFAULT 5,
  required_approvals INTEGER NOT NULL DEFAULT 4,
  total_reviews INTEGER NOT NULL DEFAULT 0,
  approvals INTEGER NOT NULL DEFAULT 0,
  rejections INTEGER NOT NULL DEFAULT 0,
  approved_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  creator_approval_reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
  creator_traction_reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
  creator_resolution_reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
  finalized_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_question_submissions_status_created
  ON market_question_submissions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_question_submissions_creator
  ON market_question_submissions(creator_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_question_reviews (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES market_question_submissions(id) ON DELETE CASCADE,
  reviewer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote VARCHAR(10) NOT NULL CHECK (vote IN ('approve', 'reject')),
  note TEXT,
  stake_ledger BIGINT NOT NULL,
  payout_ledger BIGINT NOT NULL DEFAULT 0,
  settled_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (submission_id, reviewer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_market_question_reviews_submission
  ON market_question_reviews(submission_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_market_question_reviews_reviewer
  ON market_question_reviews(reviewer_user_id, created_at DESC);
