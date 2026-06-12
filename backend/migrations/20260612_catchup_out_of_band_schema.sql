-- Catch-up migration for schema that exists in production but was created
-- out-of-band (no migration file). Discovered 2026-06-12 when replaying all
-- migrations against a fresh database for CI: the AI moderation pipeline,
-- ledger audit log, legacy user_keys table, and several columns were missing,
-- which made fresh installs/disaster recovery diverge from production
-- (e.g. registration approval silently downgraded via its 42703 fallback).
--
-- Everything here is guarded, so this is a no-op on databases that already
-- have the objects (i.e. production).

-- === AI moderation pipeline ===

CREATE TABLE IF NOT EXISTS ai_detection_daily_budget (
  day DATE PRIMARY KEY,
  calls_used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_detection_user_daily_budget (
  day DATE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calls_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_detection_user_daily_budget_user_day
  ON ai_detection_user_daily_budget (user_id, day);

CREATE TABLE IF NOT EXISTS analysis_queue (
  id BIGSERIAL PRIMARY KEY,
  content_type VARCHAR(20) NOT NULL,
  content_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  retry_count SMALLINT NOT NULL DEFAULT 0,
  priority SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT analysis_queue_content_unique UNIQUE (content_type, content_id)
);

CREATE INDEX IF NOT EXISTS idx_analysis_queue_claim
  ON analysis_queue (status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_analysis_queue_claimed_at
  ON analysis_queue (claimed_at);
CREATE INDEX IF NOT EXISTS idx_analysis_queue_user
  ON analysis_queue (user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS suspicion_score SMALLINT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_last_flag_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS ai_is_flagged BOOLEAN DEFAULT FALSE;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE;
ALTER TABLE content_ai_analysis ADD COLUMN IF NOT EXISTS detector_version VARCHAR(64);

-- === Ledger audit log + views ===

CREATE TABLE IF NOT EXISTS ledger_audit_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  category TEXT NOT NULL CHECK (category IN ('display_drift', 'stake_parity', 'global_conservation')),
  user_id BIGINT,
  event_id BIGINT,
  details JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_audit_log_category ON ledger_audit_log (category);
CREATE INDEX IF NOT EXISTS idx_ledger_audit_log_created_at ON ledger_audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_audit_log_severity ON ledger_audit_log (severity);

CREATE OR REPLACE VIEW ledger_audit_active_issues AS
SELECT l.id,
       l.created_at,
       l.severity,
       l.category,
       l.user_id,
       l.event_id,
       l.details,
       CASE
         WHEN l.user_id IS NOT NULL THEN jsonb_build_object('user_id', l.user_id, 'username', u.username)
         ELSE NULL::jsonb
       END AS user_info
FROM ledger_audit_log l
LEFT JOIN users u ON l.user_id = u.id
WHERE l.severity IN ('warn', 'error')
  AND l.created_at > (NOW() - INTERVAL '1 hour')
ORDER BY l.created_at DESC;

CREATE OR REPLACE VIEW ledger_audit_summary AS
SELECT date_trunc('hour', created_at) AS audit_hour,
       category,
       severity,
       count(*) AS issue_count,
       count(DISTINCT user_id) AS affected_users,
       min(created_at) AS first_seen,
       max(created_at) AS last_seen
FROM ledger_audit_log
WHERE created_at > (NOW() - INTERVAL '24 hours')
GROUP BY date_trunc('hour', created_at), category, severity
ORDER BY date_trunc('hour', created_at) DESC, category, severity;

-- === Market position ledger staking columns ===

ALTER TABLE user_shares ADD COLUMN IF NOT EXISTS staked_yes_ledger BIGINT DEFAULT 0;
ALTER TABLE user_shares ADD COLUMN IF NOT EXISTS staked_no_ledger BIGINT DEFAULT 0;

-- === Legacy public-key table (pre-MLS) still referenced by older paths ===

CREATE TABLE IF NOT EXISTS user_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
