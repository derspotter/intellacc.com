-- 2026-03-18: Allow "reasoning" state in post_analysis processing_status.

BEGIN;

ALTER TABLE IF EXISTS post_analysis
  DROP CONSTRAINT IF EXISTS post_analysis_processing_status_check;

ALTER TABLE IF EXISTS post_analysis
  ADD CONSTRAINT post_analysis_processing_status_check
  CHECK (
    processing_status IN (
      'not_started',
      'pending',
      'retrieving',
      'reasoning',
      'complete',
      'gated_out',
      'failed'
    )
  );

COMMIT;
