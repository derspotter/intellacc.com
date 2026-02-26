-- 2026-03-17: Track matching pipeline outcomes for observability.

BEGIN;

CREATE TABLE IF NOT EXISTS post_match_pipeline_runs (
  id BIGSERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  processing_errors TEXT,
  error_class VARCHAR(100),
  gate_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reasoner_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reasoner_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  reasoner_match BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CHECK (status IN ('not_started', 'pending', 'retrieving', 'reasoning', 'complete', 'gated_out', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_post_match_pipeline_runs_post
  ON post_match_pipeline_runs (post_id);

CREATE INDEX IF NOT EXISTS idx_post_match_pipeline_runs_status
  ON post_match_pipeline_runs (status, created_at DESC);

COMMIT;
