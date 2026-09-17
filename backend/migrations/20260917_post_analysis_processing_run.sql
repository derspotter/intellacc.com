-- Identify the current matching job without holding a transaction during AI I/O.
-- Older jobs may finish, but cannot replace the current job's status or results.
ALTER TABLE post_analysis ADD COLUMN IF NOT EXISTS processing_run_id UUID;
