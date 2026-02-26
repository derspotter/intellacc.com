-- 2026-03-16: Remove fragile LLM span offsets from optional matching reasoning schema.
-- v1 intentionally does not rely on exact evidence offsets for matching persistence.

BEGIN;

ALTER TABLE IF EXISTS propositions
  DROP COLUMN IF EXISTS evidence_start,
  DROP COLUMN IF EXISTS evidence_end;

ALTER TABLE IF EXISTS post_critiques
  DROP COLUMN IF EXISTS evidence_start,
  DROP COLUMN IF EXISTS evidence_end;

COMMIT;
