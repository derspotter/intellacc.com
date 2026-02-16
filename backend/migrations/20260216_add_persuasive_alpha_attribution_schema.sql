-- 2026-02-16: Persuasive Alpha foundation schema
-- Adds post->market attribution primitives and optional market update referral metadata.

BEGIN;

CREATE TABLE IF NOT EXISTS post_market_matches (
    id SERIAL PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    match_score DECIMAL(10, 6) NOT NULL DEFAULT 0.0,
    match_method VARCHAR(20) NOT NULL DEFAULT 'fts_v1',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_post_market_match UNIQUE (post_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_post_market_matches_post ON post_market_matches(post_id);
CREATE INDEX IF NOT EXISTS idx_post_market_matches_event ON post_market_matches(event_id);

CREATE TABLE IF NOT EXISTS post_market_clicks (
    id SERIAL PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE,
    consumed_by_market_update_id INTEGER,
    CONSTRAINT post_market_clicks_post_event_user_unique_once_per_click_window
      UNIQUE (post_id, event_id, user_id, clicked_at)
);

CREATE INDEX IF NOT EXISTS idx_post_market_clicks_user_event_clicked
    ON post_market_clicks(user_id, event_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_market_clicks_expires
    ON post_market_clicks(expires_at);

ALTER TABLE market_updates
    ADD COLUMN IF NOT EXISTS referral_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS referral_click_id INTEGER,
    ADD COLUMN IF NOT EXISTS had_prior_position BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_market_updates_referral_post
    ON market_updates(referral_post_id, event_id);
CREATE INDEX IF NOT EXISTS idx_market_updates_referral_click
    ON market_updates(referral_click_id);

COMMIT;
