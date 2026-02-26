-- 2026-03-19: Ensure pgvector extension and events.embedding exist on environments
-- where earlier matcher migrations ran before pgvector package was installed.

BEGIN;

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

COMMIT;
