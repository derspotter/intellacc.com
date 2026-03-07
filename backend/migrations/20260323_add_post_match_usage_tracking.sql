-- 2026-03-23: Track OpenRouter usage and cost for post-market matching.

BEGIN;

ALTER TABLE IF EXISTS post_analysis
  ADD COLUMN IF NOT EXISTS api_call_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS api_success_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prompt_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_credits NUMERIC(18,8) NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS post_match_pipeline_runs
  ADD COLUMN IF NOT EXISTS api_call_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS api_success_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prompt_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_credits NUMERIC(18,8) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS post_match_api_usage (
  id BIGSERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  stage VARCHAR(32) NOT NULL,
  operation VARCHAR(32) NOT NULL,
  requested_model VARCHAR(150),
  used_model VARCHAR(150),
  success BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms INTEGER,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  cost_credits NUMERIC(18,8) NOT NULL DEFAULT 0,
  provider_response_id TEXT,
  error_class VARCHAR(100),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_match_api_usage_post
  ON post_match_api_usage (post_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_post_match_api_usage_stage
  ON post_match_api_usage (stage, created_at DESC);

COMMIT;
