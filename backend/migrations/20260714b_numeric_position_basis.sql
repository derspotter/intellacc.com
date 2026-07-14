-- Per-user, per-event cost basis for numeric distribution positions.
--
-- Fixes a HIGH-severity money-path bug: sell/resolution unstake previously used
-- SUM(distribution_trades.total_cost_ledger) as a proxy for "how much this user
-- actually has staked on this event". Under LMSR convexity that proxy is wrong
-- whenever another trader moves the market between this user's buy and sell
-- (the vector cost of an equivalent-looking trade changes with q) — leading to
-- resolution rollback loops, cross-event rp_staked_ledger theft/leaks, and
-- invariant false-positives. This table tracks the exact ledger amount the
-- user actually staked (debited) on this event, independent of any other
-- trader's activity.
--
-- Idempotent: safe to replay.
CREATE TABLE IF NOT EXISTS numeric_position_basis (
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  basis_ledger BIGINT NOT NULL DEFAULT 0 CHECK (basis_ledger >= 0),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, event_id)
);
