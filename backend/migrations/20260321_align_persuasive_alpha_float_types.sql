-- 2026-03-21: Align persuasive-alpha probability/score columns with LMSR float math.
-- Convert settlement fields from NUMERIC to DOUBLE PRECISION so DB and Rust types match.

BEGIN;

ALTER TABLE IF EXISTS post_signal_episodes
    ALTER COLUMN p_before TYPE DOUBLE PRECISION USING p_before::double precision,
    ALTER COLUMN p_after TYPE DOUBLE PRECISION USING p_after::double precision,
    ALTER COLUMN s_early TYPE DOUBLE PRECISION USING s_early::double precision,
    ALTER COLUMN s_mid TYPE DOUBLE PRECISION USING s_mid::double precision,
    ALTER COLUMN s_final TYPE DOUBLE PRECISION USING s_final::double precision,
    ALTER COLUMN combined_score TYPE DOUBLE PRECISION USING combined_score::double precision;

ALTER TABLE IF EXISTS post_signal_reward_payouts
    ALTER COLUMN score_component TYPE DOUBLE PRECISION USING score_component::double precision,
    ALTER COLUMN mint_rate_snapshot TYPE DOUBLE PRECISION USING mint_rate_snapshot::double precision;

COMMIT;
