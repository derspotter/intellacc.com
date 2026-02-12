-- Durable per-user weekly assignment state so completion/penalty can be processed safely
-- even if users.weekly_* fields are overwritten by assignment rollover.

CREATE TABLE IF NOT EXISTS weekly_user_assignments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_year VARCHAR(8) NOT NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  required_stake_ledger BIGINT NOT NULL DEFAULT 0,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMP,
  penalty_applied BOOLEAN NOT NULL DEFAULT FALSE,
  penalty_amount_ledger BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, week_year)
);

CREATE INDEX IF NOT EXISTS idx_weekly_user_assignments_week
  ON weekly_user_assignments(week_year);

CREATE INDEX IF NOT EXISTS idx_weekly_user_assignments_completion
  ON weekly_user_assignments(week_year, completed, penalty_applied);

-- Backfill currently assigned users into immutable weekly rows.
INSERT INTO weekly_user_assignments (
  user_id,
  week_year,
  event_id,
  required_stake_ledger,
  completed,
  completed_at,
  penalty_applied,
  penalty_amount_ledger
)
SELECT
  u.id,
  u.weekly_assignment_week,
  u.weekly_assigned_event_id,
  GREATEST(COALESCE(u.rp_balance_ledger, 0) / 100, 0),
  COALESCE(u.weekly_assignment_completed, FALSE),
  u.weekly_assignment_completed_at,
  EXISTS (
    SELECT 1
    FROM weekly_decay_log wdl
    WHERE wdl.user_id = u.id
      AND wdl.week_year = u.weekly_assignment_week
  ),
  0
FROM users u
WHERE u.weekly_assignment_week IS NOT NULL
  AND u.weekly_assigned_event_id IS NOT NULL
ON CONFLICT (user_id, week_year) DO NOTHING;
