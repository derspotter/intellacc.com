-- 2025-01-27: Add comprehensive ledger audit system
-- Provides automated monitoring of ledger consistency and stake parity

BEGIN;

-- 1) Audit log table for recording any issues
CREATE TABLE IF NOT EXISTS ledger_audit_log (
    id            BIGSERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    severity      TEXT        NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
    category      TEXT        NOT NULL CHECK (category IN ('display_drift', 'stake_parity', 'global_conservation')),
    user_id       BIGINT,
    event_id      BIGINT,
    details       JSONB       NOT NULL
);

-- Index for efficient querying
CREATE INDEX IF NOT EXISTS idx_ledger_audit_log_created_at ON ledger_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_audit_log_severity ON ledger_audit_log(severity);
CREATE INDEX IF NOT EXISTS idx_ledger_audit_log_category ON ledger_audit_log(category);

-- 2) Main audit function with stricter thresholds
CREATE OR REPLACE FUNCTION run_ledger_audit() RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_display_threshold BIGINT := 5000;  -- 0.005 RP tolerance (stricter than before)
    v_audit_start TIMESTAMPTZ := NOW();
    v_issues_found INTEGER := 0;
BEGIN
    -- A) Display drift audit (should be 0 after generated columns)
    INSERT INTO ledger_audit_log(severity, category, user_id, details)
    SELECT
        CASE WHEN ABS(ROUND(u.rp_balance * 1000000.0)::BIGINT - u.rp_balance_ledger) > v_display_threshold
             THEN 'error' ELSE 'info' END AS severity,
        'display_drift' AS category,
        u.id AS user_id,
        jsonb_build_object(
            'rp_balance', u.rp_balance,
            'rp_balance_ledger', u.rp_balance_ledger,
            'diff_microRP', ABS(ROUND(u.rp_balance * 1000000.0)::BIGINT - u.rp_balance_ledger),
            'rp_staked', u.rp_staked,
            'rp_staked_ledger', u.rp_staked_ledger,
            'staked_diff_microRP', ABS(ROUND(u.rp_staked * 1000000.0)::BIGINT - u.rp_staked_ledger)
        ) AS details
    FROM users u
    WHERE ABS(ROUND(u.rp_balance * 1000000.0)::BIGINT - u.rp_balance_ledger) > 0
       OR ABS(ROUND(u.rp_staked * 1000000.0)::BIGINT - u.rp_staked_ledger) > 0;

    GET DIAGNOSTICS v_issues_found = ROW_COUNT;

    -- B) Stake parity audit: users.rp_staked_ledger should equal sum of event stakes
    WITH per_user_stake_summary AS (
        SELECT
            u.id AS user_id,
            u.rp_staked_ledger,
            COALESCE(SUM(us.total_staked_ledger), 0)::BIGINT AS sum_event_staked_ledger,
            COUNT(us.event_id) as active_markets
        FROM users u
        LEFT JOIN user_shares us ON us.user_id = u.id AND (us.yes_shares > 0 OR us.no_shares > 0)
        GROUP BY u.id, u.rp_staked_ledger
    )
    INSERT INTO ledger_audit_log(severity, category, user_id, details)
    SELECT
        CASE WHEN (p.rp_staked_ledger - p.sum_event_staked_ledger) = 0 THEN 'info' ELSE 'error' END,
        'stake_parity',
        p.user_id,
        jsonb_build_object(
            'rp_staked_ledger', p.rp_staked_ledger,
            'sum_event_staked_ledger', p.sum_event_staked_ledger,
            'diff_ledger', (p.rp_staked_ledger - p.sum_event_staked_ledger),
            'diff_rp', (p.rp_staked_ledger - p.sum_event_staked_ledger)::NUMERIC / 1000000.0,
            'active_markets', p.active_markets
        )
    FROM per_user_stake_summary p
    WHERE (p.rp_staked_ledger - p.sum_event_staked_ledger) <> 0;

    GET DIAGNOSTICS v_issues_found = v_issues_found + ROW_COUNT;

    -- C) Side-specific stake consistency within user_shares
    INSERT INTO ledger_audit_log(severity, category, user_id, event_id, details)
    SELECT
        'error' as severity,
        'stake_parity' as category,
        us.user_id,
        us.event_id,
        jsonb_build_object(
            'total_staked_ledger', us.total_staked_ledger,
            'staked_yes_ledger', us.staked_yes_ledger,
            'staked_no_ledger', us.staked_no_ledger,
            'calculated_total', (us.staked_yes_ledger + us.staked_no_ledger),
            'diff', (us.total_staked_ledger - (us.staked_yes_ledger + us.staked_no_ledger)),
            'issue', 'side_specific_stake_mismatch'
        )
    FROM user_shares us
    WHERE us.total_staked_ledger <> (us.staked_yes_ledger + us.staked_no_ledger);

    GET DIAGNOSTICS v_issues_found = v_issues_found + ROW_COUNT;

    -- D) Log summary
    INSERT INTO ledger_audit_log(severity, category, details)
    VALUES (
        CASE WHEN v_issues_found = 0 THEN 'info' ELSE 'warn' END,
        'display_drift',
        jsonb_build_object(
            'audit_duration_ms', EXTRACT(epoch FROM (NOW() - v_audit_start)) * 1000,
            'total_issues_found', v_issues_found,
            'audit_timestamp', v_audit_start
        )
    );

    -- E) Send notifications for critical issues
    IF v_issues_found > 0 THEN
        PERFORM pg_notify(
            'ledger_audit_critical',
            jsonb_build_object(
                'timestamp', NOW(),
                'issues_found', v_issues_found,
                'message', 'Ledger audit detected inconsistencies'
            )::text
        );
    END IF;

END;
$$;

-- 3) Cleanup function to prevent log table from growing indefinitely
CREATE OR REPLACE FUNCTION prune_ledger_audit_log() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM ledger_audit_log 
    WHERE created_at < NOW() - INTERVAL '90 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    INSERT INTO ledger_audit_log(severity, category, details)
    VALUES (
        'info',
        'display_drift',
        jsonb_build_object(
            'operation', 'log_pruning',
            'deleted_rows', deleted_count,
            'retention_days', 90
        )
    );
    
    RETURN deleted_count;
END;
$$;

-- 4) Convenience views for monitoring
CREATE OR REPLACE VIEW ledger_audit_summary AS
SELECT 
    DATE_TRUNC('hour', created_at) as audit_hour,
    category,
    severity,
    COUNT(*) as issue_count,
    COUNT(DISTINCT user_id) as affected_users,
    MIN(created_at) as first_seen,
    MAX(created_at) as last_seen
FROM ledger_audit_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('hour', created_at), category, severity
ORDER BY audit_hour DESC, category, severity;

CREATE OR REPLACE VIEW ledger_audit_active_issues AS
SELECT 
    l.*,
    CASE 
        WHEN l.user_id IS NOT NULL THEN 
            jsonb_build_object('user_id', l.user_id, 'username', u.username)
        ELSE NULL 
    END as user_info
FROM ledger_audit_log l
LEFT JOIN users u ON l.user_id = u.id
WHERE l.severity IN ('warn', 'error')
  AND l.created_at > NOW() - INTERVAL '1 hour'
ORDER BY l.created_at DESC;

-- 5) Example pg_cron setup (commented out - enable manually if pg_cron is available)
/*
-- Requires: CREATE EXTENSION IF NOT EXISTS pg_cron;
-- Every 5 minutes
SELECT cron.schedule('ledger_audit_5min', '*/5 * * * *', $$SELECT run_ledger_audit();$$);

-- Daily cleanup at 3:15 AM
SELECT cron.schedule('ledger_audit_prune_daily', '15 3 * * *', $$SELECT prune_ledger_audit_log();$$);

-- To remove scheduled jobs:
-- SELECT cron.unschedule('ledger_audit_5min');
-- SELECT cron.unschedule('ledger_audit_prune_daily');
*/

COMMIT;

-- Post-installation verification queries (run separately)
/*
-- Run initial audit to establish baseline
SELECT run_ledger_audit();

-- Check audit results
SELECT * FROM ledger_audit_summary;

-- Check for any active issues
SELECT * FROM ledger_audit_active_issues;

-- Manual stake parity check query
SELECT 
    u.id,
    u.username,
    u.rp_staked_ledger,
    COALESCE(SUM(us.total_staked_ledger), 0) AS sum_event_staked_ledger,
    (u.rp_staked_ledger - COALESCE(SUM(us.total_staked_ledger), 0)) AS diff_ledger,
    CASE 
        WHEN u.rp_staked_ledger = COALESCE(SUM(us.total_staked_ledger), 0) THEN 'MATCH'
        ELSE 'MISMATCH'
    END as status
FROM users u
LEFT JOIN user_shares us ON us.user_id = u.id
GROUP BY u.id, u.username, u.rp_staked_ledger
HAVING u.rp_staked_ledger <> COALESCE(SUM(us.total_staked_ledger), 0)
ORDER BY ABS(u.rp_staked_ledger - COALESCE(SUM(us.total_staked_ledger), 0)) DESC;
*/