-- Random resolution-proposer assignments: closed, unresolved, visible binary
-- markets are handed to a randomly drawn eligible user who is asked (not
-- obliged) to propose a resolution. Assignment itself is free; submitting the
-- proposal still stakes the usual 50 RP through marketResolutionController.
-- Windows, caps and eligibility live in resolutionAssignmentService.

CREATE TABLE IF NOT EXISTS market_resolution_assignments (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- pending   : live, counts against the per-user cap
  -- completed : the assignee submitted a proposal for this market
  -- declined  : the assignee handed it back (7-day re-draw exclusion)
  -- expired   : the deadline passed unanswered (7-day re-draw exclusion)
  -- cancelled : withdrawn by maintenance (market resolved/hidden, someone
  --             else proposed, assignee no longer eligible) — no exclusion
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'declined', 'expired', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  proposal_id INTEGER REFERENCES market_resolution_proposals(id) ON DELETE SET NULL,
  -- Set when the row leaves 'pending'; drives the re-draw exclusion window.
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one live assignment per market.
CREATE UNIQUE INDEX IF NOT EXISTS uq_market_resolution_assignments_active
  ON market_resolution_assignments(event_id)
  WHERE status = 'pending';

-- Per-user cap lookups and the authenticated assignment queue.
CREATE INDEX IF NOT EXISTS idx_market_resolution_assignments_user_status
  ON market_resolution_assignments(user_id, status, created_at DESC);

-- Expiry sweep.
CREATE INDEX IF NOT EXISTS idx_market_resolution_assignments_pending_expiry
  ON market_resolution_assignments(expires_at)
  WHERE status = 'pending';

-- "Did this user already decline/expire on this market recently?"
CREATE INDEX IF NOT EXISTS idx_market_resolution_assignments_event_user
  ON market_resolution_assignments(event_id, user_id, resolved_at DESC);
