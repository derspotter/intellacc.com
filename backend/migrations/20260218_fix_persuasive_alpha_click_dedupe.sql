-- 2026-02-18: Fix persuasive attribution click deduplication
-- The previous unique constraint included clicked_at, which did not block
-- multiple active clicks for the same user/event/post.

BEGIN;

ALTER TABLE post_market_clicks
    DROP CONSTRAINT IF EXISTS post_market_clicks_post_event_user_unique_once_per_click_window;

CREATE UNIQUE INDEX IF NOT EXISTS uq_post_market_clicks_active_user_post_event
    ON post_market_clicks (post_id, event_id, user_id)
    WHERE consumed_at IS NULL;

COMMIT;
