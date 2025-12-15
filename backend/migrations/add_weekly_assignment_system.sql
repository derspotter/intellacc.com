-- Add weekly assignment and decay system

-- Add simple weekly assignment column to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS weekly_assigned_event_id INTEGER REFERENCES events(id),
ADD COLUMN IF NOT EXISTS weekly_assignment_week VARCHAR(8), -- Format: YYYY-WXX (e.g., 2025-W03)
ADD COLUMN IF NOT EXISTS weekly_assignment_completed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS weekly_assignment_completed_at TIMESTAMP;

-- Create indexes for weekly assignment queries
CREATE INDEX IF NOT EXISTS idx_users_weekly_assignment ON users(weekly_assigned_event_id, weekly_assignment_week);
CREATE INDEX IF NOT EXISTS idx_users_weekly_completion ON users(weekly_assignment_completed, weekly_assignment_week);

-- Create index for week-based queries
CREATE INDEX IF NOT EXISTS idx_assigned_predictions_week ON assigned_predictions(week_year);
CREATE INDEX IF NOT EXISTS idx_assigned_predictions_user_week ON assigned_predictions(user_id, week_year);

-- Weekly decay tracking table
CREATE TABLE IF NOT EXISTS weekly_decay_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_year VARCHAR(8) NOT NULL, -- Format: YYYY-WXX
    rp_before_decay DECIMAL(15,2) NOT NULL,
    decay_amount DECIMAL(15,2) NOT NULL,
    rp_after_decay DECIMAL(15,2) NOT NULL,
    processed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, week_year)
);

-- Create index for decay queries
CREATE INDEX IF NOT EXISTS idx_weekly_decay_week ON weekly_decay_log(week_year);
CREATE INDEX IF NOT EXISTS idx_weekly_decay_user ON weekly_decay_log(user_id);

-- Weekly assignment statistics
CREATE TABLE IF NOT EXISTS weekly_assignment_stats (
    id SERIAL PRIMARY KEY,
    week_year VARCHAR(8) NOT NULL,
    total_users INTEGER DEFAULT 0,
    total_assignments INTEGER DEFAULT 0,
    completed_assignments INTEGER DEFAULT 0,
    completion_rate DECIMAL(5,2) DEFAULT 0.0,
    total_rewards_paid DECIMAL(15,2) DEFAULT 0.0,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(week_year)
);

-- Create functions for week calculations
CREATE OR REPLACE FUNCTION get_current_week() RETURNS VARCHAR(8) AS $$
BEGIN
    RETURN TO_CHAR(NOW(), 'YYYY-"W"IW');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_previous_week() RETURNS VARCHAR(8) AS $$
BEGIN
    RETURN TO_CHAR(NOW() - INTERVAL '1 week', 'YYYY-"W"IW');
END;
$$ LANGUAGE plpgsql;

-- Update the existing assigned_predictions to use current week if week_year is null
UPDATE assigned_predictions 
SET week_year = get_current_week()
WHERE week_year IS NULL;

-- Create a view for current week assignments
CREATE OR REPLACE VIEW current_week_assignments AS
SELECT 
    u.id as user_id,
    u.username,
    u.weekly_assigned_event_id,
    u.weekly_assignment_week,
    u.weekly_assignment_completed,
    u.weekly_assignment_completed_at,
    e.title as event_title,
    e.closing_date,
    CASE 
        WHEN p.id IS NOT NULL THEN true 
        ELSE false 
    END as has_prediction,
    p.prediction_value,
    NULL::NUMERIC AS confidence,
    p.outcome
FROM users u
LEFT JOIN events e ON u.weekly_assigned_event_id = e.id
LEFT JOIN predictions p ON u.id = p.user_id AND u.weekly_assigned_event_id = p.event_id
WHERE u.weekly_assignment_week = get_current_week();