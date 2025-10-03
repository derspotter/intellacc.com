-- 20250909_align_predictions_schema.sql
-- Ensure legacy databases have the newer columns leveraged by leaderboard/portfolio features

BEGIN;

-- Events table enhancements
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS category VARCHAR(100);

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS event_type VARCHAR(20) DEFAULT 'binary';

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS numerical_outcome DECIMAL(15,6);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'events_event_type_check' AND conrelid = 'events'::regclass
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_event_type_check
            CHECK (event_type IN ('binary', 'numeric', 'discrete', 'multiple_choice', 'date'));
    END IF;
END
$$;

-- Predictions table enhancements for advanced scoring
ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS prediction_type VARCHAR(20) DEFAULT 'binary';

ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS numerical_value DECIMAL(15,6);

ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS lower_bound DECIMAL(15,6);

ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS upper_bound DECIMAL(15,6);

ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS actual_value DECIMAL(15,6);

ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS numerical_score DECIMAL(10,6);

ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS prob_vector JSONB;

ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS raw_log_loss DECIMAL(10,6);

ALTER TABLE predictions
    ADD COLUMN IF NOT EXISTS outcome_index INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'predictions_prediction_type_check' AND conrelid = 'predictions'::regclass
    ) THEN
        ALTER TABLE predictions
            ADD CONSTRAINT predictions_prediction_type_check
            CHECK (prediction_type IN ('binary', 'numeric', 'discrete', 'multiple_choice', 'date'));
    END IF;
END
$$;

-- Helpful indexes used in analytics code paths
CREATE INDEX IF NOT EXISTS idx_predictions_type ON predictions(prediction_type);
CREATE INDEX IF NOT EXISTS idx_predictions_log_loss ON predictions(raw_log_loss);
CREATE INDEX IF NOT EXISTS idx_predictions_prob_vector ON predictions USING GIN(prob_vector);

COMMIT;
