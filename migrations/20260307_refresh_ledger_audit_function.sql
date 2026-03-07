-- 2026-03-07: Refresh ledger audit function for ledger-only schema
-- Existing databases have already applied the historical 20250127 migration, so
-- this forward migration replaces run_ledger_audit() without editing history.

BEGIN;

CREATE OR REPLACE FUNCTION run_ledger_audit() RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_audit_start TIMESTAMPTZ := NOW();
    v_issues_found INTEGER := 0;
    v_rc INTEGER := 0;
BEGIN
    -- A) Display drift audit removed because rp_balance / rp_staked float columns
    -- are no longer part of the runtime ledger model.

    -- B) Stake parity audit: users.rp_staked_ledger should equal sum of event stakes
    WITH per_user_stake_summary AS (
        SELECT
            u.id AS user_id,
            u.rp_staked_ledger,
            COALESCE(SUM(us.total_staked_ledger), 0)::BIGINT AS sum_event_staked_ledger,
            COUNT(us.event_id) AS active_markets
        FROM users u
        LEFT JOIN user_shares us
          ON us.user_id = u.id
         AND (us.yes_shares > 0 OR us.no_shares > 0)
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

    GET DIAGNOSTICS v_rc = ROW_COUNT;
    v_issues_found := v_issues_found + v_rc;

    -- C) Side-specific stake consistency within user_shares
    INSERT INTO ledger_audit_log(severity, category, user_id, event_id, details)
    SELECT
        'error' AS severity,
        'stake_parity' AS category,
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

    GET DIAGNOSTICS v_rc = ROW_COUNT;
    v_issues_found := v_issues_found + v_rc;

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

COMMIT;
