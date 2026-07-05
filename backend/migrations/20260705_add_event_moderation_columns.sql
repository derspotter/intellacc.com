-- Junk-event flagging (reversible hide) + idempotence marker for the combined
-- Gemma topic+junk classification call. hidden_reason is prefixed 'llm: ' for
-- model verdicts so manual hides are distinguishable and never auto-cleared.
ALTER TABLE events ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS llm_checked_at TIMESTAMPTZ;
