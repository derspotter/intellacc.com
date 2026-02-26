-- 2026-03-12: Optional matching schema for OpenRouter-based post/market matching

BEGIN;

-- Try to install pgvector only if available in this environment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'vector'
  ) THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  END IF;
END $$;

-- Vector embedding for events (only when pgvector is installed).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'vector'
  ) THEN
    ALTER TABLE events
      ADD COLUMN IF NOT EXISTS embedding vector(768);

    CREATE INDEX IF NOT EXISTS idx_events_embedding
      ON events USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 200);
  END IF;
END $$;

-- Full-text search vector for hybrid ranking.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      COALESCE(title, '') || ' ' || COALESCE(details, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_events_fts
  ON events USING GIN(search_vector);

-- Optional normalized domain used for candidate restriction.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS domain VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_events_domain
  ON events(domain);

CREATE INDEX IF NOT EXISTS idx_events_domain_open
  ON events(domain, closing_date)
  WHERE outcome IS NULL;

-- Matching analysis state for post processing.
CREATE TABLE IF NOT EXISTS post_analysis (
  post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  has_claim BOOLEAN NOT NULL DEFAULT FALSE,
  domain VARCHAR(50),
  claim_summary TEXT,
  entities TEXT[],
  processing_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'gated_out', 'retrieving', 'complete', 'failed', 'not_started')),
  gate_model VARCHAR(100),
  reason_model VARCHAR(100),
  gate_latency_ms INTEGER,
  reason_latency_ms INTEGER,
  processing_errors TEXT,
  candidates_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMIT;
