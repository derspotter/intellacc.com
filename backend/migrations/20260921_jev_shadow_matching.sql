-- Latest shadow observation per post. No changes to matching or reward tables.
CREATE TABLE IF NOT EXISTS post_match_jev_shadow (
  post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  processing_run_id UUID NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'skipped', 'error')),
  result JSONB NOT NULL,
  baseline JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
