-- 2026-02-27: Moderation reporting and user blocking baseline
-- Adds post/comment reporting, admin review state, and user-level blocking.

BEGIN;

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS user_blocks (
    id SERIAL PRIMARY KEY,
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT user_blocks_blocked_unique UNIQUE (blocker_id, blocked_user_id),
    CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker_id
    ON user_blocks(blocker_id);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_user_id
    ON user_blocks(blocked_user_id);

CREATE TABLE IF NOT EXISTS moderation_reports (
    id SERIAL PRIMARY KEY,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_content_type VARCHAR(20) NOT NULL,
    reported_content_id INTEGER,
    report_reason TEXT NOT NULL,
    details TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    review_action VARCHAR(20),
    review_note TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT moderation_reports_content_type
      CHECK (reported_content_type IN ('post', 'comment', 'user')),
    CONSTRAINT moderation_reports_status
      CHECK (status IN ('open', 'dismissed', 'resolved')),
    CONSTRAINT moderation_reports_action
      CHECK (review_action IN ('dismiss', 'hide_content', 'no_action') OR review_action IS NULL),
    CONSTRAINT moderation_reports_report_type_target CHECK (
      (reported_content_type IN ('post', 'comment') AND reported_content_id IS NOT NULL)
      OR (reported_content_type = 'user' AND reported_content_id IS NULL)
    ),
    CONSTRAINT moderation_reports_no_self_report
      CHECK (reporter_id <> reported_user_id)
);

CREATE INDEX IF NOT EXISTS idx_moderation_reports_status_created
    ON moderation_reports(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_moderation_reports_reported_content
    ON moderation_reports(reported_content_type, reported_content_id);

COMMIT;
