-- Durable, bounded link-preview enrichment; no network work in post writes.
CREATE TABLE IF NOT EXISTS post_link_preview_jobs (
  post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  generation UUID NOT NULL DEFAULT gen_random_uuid(),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_id UUID,
  locked_until TIMESTAMPTZ,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS post_link_preview_jobs_ready
  ON post_link_preview_jobs (available_at, post_id) WHERE attempts < 3;
