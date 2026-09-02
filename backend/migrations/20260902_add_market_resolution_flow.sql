-- Community market resolution: proposals, random juries, staked votes.
-- Economic params (stakes, quorum, windows) are enforced in backend
-- controller logic (marketResolutionController), mirroring the
-- market-question validation flow.

-- Jury eligibility needs login recency; stamped (throttled) by auth middleware.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS market_resolution_proposals (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  proposer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Exactly one of proposed_outcome ('yes'/'no') or proposed_outcome_id is set.
  proposed_outcome VARCHAR(10) CHECK (proposed_outcome IN ('yes', 'no')),
  proposed_outcome_id BIGINT,
  source_url TEXT NOT NULL,
  note TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'voting'
    CHECK (status IN ('voting', 'challenge_window', 'confirmed', 'escalated', 'overturned')),
  proposer_stake_ledger BIGINT NOT NULL,
  proposer_stake_settled BOOLEAN NOT NULL DEFAULT FALSE,
  jury_size INTEGER NOT NULL,
  confirms INTEGER NOT NULL DEFAULT 0,
  rejects INTEGER NOT NULL DEFAULT 0,
  voting_deadline_at TIMESTAMPTZ NOT NULL,
  challenge_ends_at TIMESTAMPTZ,
  escalation_reason VARCHAR(40),
  admin_ruled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_outcome VARCHAR(10),
  admin_outcome_id BIGINT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live proposal per market at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_market_resolution_proposals_active
  ON market_resolution_proposals(event_id)
  WHERE status IN ('voting', 'challenge_window', 'escalated');

CREATE INDEX IF NOT EXISTS idx_market_resolution_proposals_status
  ON market_resolution_proposals(status, created_at DESC);

CREATE TABLE IF NOT EXISTS market_resolution_jurors (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES market_resolution_proposals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (proposal_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_market_resolution_jurors_user
  ON market_resolution_jurors(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_resolution_votes (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES market_resolution_proposals(id) ON DELETE CASCADE,
  voter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote VARCHAR(10) NOT NULL CHECK (vote IN ('confirm', 'reject')),
  note TEXT,
  stake_ledger BIGINT NOT NULL,
  payout_ledger BIGINT NOT NULL DEFAULT 0,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (proposal_id, voter_user_id)
);

CREATE INDEX IF NOT EXISTS idx_market_resolution_votes_proposal
  ON market_resolution_votes(proposal_id, created_at ASC);
