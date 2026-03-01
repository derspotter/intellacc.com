-- 2026-03-20: Persuasive Alpha settlement schema
-- Adds episodes, payouts, and run records for the nightly scoring pipeline.

BEGIN;

CREATE TABLE IF NOT EXISTS post_signal_episodes (
    id SERIAL PRIMARY KEY,
    market_update_id INTEGER NOT NULL UNIQUE REFERENCES market_updates(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    trader_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    episode_bucket_start TIMESTAMP WITH TIME ZONE NOT NULL,
    episode_type VARCHAR(20) NOT NULL, -- 'attention', 'belief'
    is_meaningful BOOLEAN NOT NULL DEFAULT FALSE,
    p_before DECIMAL(10, 6) NOT NULL,
    p_after DECIMAL(10, 6) NOT NULL,
    s_early DECIMAL(10, 6),
    s_mid DECIMAL(10, 6),
    s_final DECIMAL(10, 6),
    finalized_early_at TIMESTAMP WITH TIME ZONE,
    finalized_mid_at TIMESTAMP WITH TIME ZONE,
    finalized_final_at TIMESTAMP WITH TIME ZONE,
    combined_score DECIMAL(10, 6) NOT NULL DEFAULT 0.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_signal_episodes_post ON post_signal_episodes(post_id);
CREATE INDEX IF NOT EXISTS idx_post_signal_episodes_event ON post_signal_episodes(event_id);
CREATE INDEX IF NOT EXISTS idx_post_signal_episodes_trader ON post_signal_episodes(trader_user_id);
CREATE INDEX IF NOT EXISTS idx_post_signal_episodes_bucket ON post_signal_episodes(episode_bucket_start);

CREATE TABLE IF NOT EXISTS post_signal_reward_payouts (
    id SERIAL PRIMARY KEY,
    episode_id INTEGER NOT NULL REFERENCES post_signal_episodes(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    component VARCHAR(10) NOT NULL, -- 'early', 'mid', 'final'
    score_component DECIMAL(10, 6) NOT NULL,
    mint_rate_snapshot DECIMAL(14, 6) NOT NULL,
    reward_ledger BIGINT NOT NULL,
    payout_status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'minted', 'skipped_by_cap'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_post_signal_reward_component UNIQUE (episode_id, component)
);

CREATE INDEX IF NOT EXISTS idx_post_signal_payouts_author ON post_signal_reward_payouts(author_user_id);
CREATE INDEX IF NOT EXISTS idx_post_signal_payouts_status ON post_signal_reward_payouts(payout_status);
CREATE INDEX IF NOT EXISTS idx_post_signal_payouts_created ON post_signal_reward_payouts(created_at);

CREATE TABLE IF NOT EXISTS post_signal_run_logs (
    id SERIAL PRIMARY KEY,
    ts_started TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    ts_finished TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,
    trigger_type VARCHAR(20) NOT NULL, -- 'cron', 'admin', 'manual'
    is_enabled BOOLEAN NOT NULL,
    processed_updates INTEGER NOT NULL DEFAULT 0,
    attributed_updates INTEGER NOT NULL DEFAULT 0,
    episodes_created INTEGER NOT NULL DEFAULT 0,
    payout_rows_created INTEGER NOT NULL DEFAULT 0,
    minted_ledger_total BIGINT NOT NULL DEFAULT 0,
    skipped_by_cap INTEGER NOT NULL DEFAULT 0,
    skipped_by_threshold INTEGER NOT NULL DEFAULT 0,
    claim_conflicts INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    run_log JSONB
);

COMMIT;
