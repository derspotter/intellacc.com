-- Keep the OpenAI vectors used for topic classification and rollback intact.
ALTER TABLE events ADD COLUMN IF NOT EXISTS embedding_bge_m3 vector(1024);
ALTER TABLE events ADD COLUMN IF NOT EXISTS embedding_bge_m3_source_hash TEXT;
-- Only a small live subset is searched; exact scanning avoids ANN filtering loss.
