-- backend/migrations/initial_migration.sql
-- Complete database schema for Intellacc platform
-- Includes all tables, indexes, triggers, and constraints

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    role VARCHAR(20) DEFAULT 'user',
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    bio TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Posts table (handles both posts and comments)
CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    image_url VARCHAR(255),
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    depth INTEGER DEFAULT 0,
    is_comment BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Add indexes for better performance on hierarchical queries
CREATE INDEX IF NOT EXISTS idx_posts_parent_id ON posts(parent_id);
CREATE INDEX IF NOT EXISTS idx_posts_is_comment ON posts(is_comment);
CREATE INDEX IF NOT EXISTS idx_posts_depth ON posts(depth);

-- Topics table
CREATE TABLE IF NOT EXISTS topics (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    details TEXT,
    closing_date TIMESTAMP NOT NULL,
    outcome VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    -- Event type and numerical outcome support
    category VARCHAR(100), -- e.g., 'politics', 'economics', 'science'
    event_type VARCHAR(20) DEFAULT 'binary' CHECK (event_type IN ('binary', 'numeric', 'discrete', 'multiple_choice', 'date')),
    numerical_outcome DECIMAL(15,6) -- For resolved numerical events
);

-- User visibility score table
CREATE TABLE IF NOT EXISTS user_visibility_score (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    score FLOAT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Predictions table
CREATE TABLE IF NOT EXISTS predictions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    event TEXT NOT NULL, -- Stores event name
    prediction_value TEXT NOT NULL,
    confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
    created_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP,
    outcome TEXT CHECK (outcome IN ('correct', 'incorrect', 'pending')),
    -- Numerical prediction support
    prediction_type VARCHAR(20) DEFAULT 'binary' CHECK (prediction_type IN ('binary', 'numeric', 'discrete', 'multiple_choice', 'date')),
    numerical_value DECIMAL(15,6), -- Point estimate for numerical predictions
    lower_bound DECIMAL(15,6), -- Lower bound of confidence interval
    upper_bound DECIMAL(15,6), -- Upper bound of confidence interval
    actual_value DECIMAL(15,6), -- Actual numerical outcome for resolved predictions
    numerical_score DECIMAL(10,6), -- Interval score or other numerical scoring metric
    -- Unified log scoring system columns
    prob_vector JSONB, -- Probability vector for all prediction types
    raw_log_loss DECIMAL(10,6), -- Raw log loss score (lower is better)
    outcome_index INTEGER, -- Index of correct outcome for multi-choice questions
    UNIQUE(user_id, event_id) -- Ensure a user can only predict an event once
);

-- Follows table
CREATE TABLE IF NOT EXISTS follows (
    id SERIAL PRIMARY KEY,
    follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(follower_id, following_id)
);

-- Assigned predictions table
CREATE TABLE IF NOT EXISTS assigned_predictions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    prediction_id INTEGER REFERENCES predictions(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT NOW(),
    completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP,
    month_year VARCHAR(7), -- Format: YYYY-MM
    UNIQUE(user_id, prediction_id)
);

-- Bets table
CREATE TABLE IF NOT EXISTS bets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    prediction_id INTEGER REFERENCES predictions(id) ON DELETE CASCADE,
    confidence_level INTEGER NOT NULL CHECK (confidence_level BETWEEN 1 AND 10),
    bet_on TEXT NOT NULL, -- What they bet on (e.g., "true", "false", specific option)
    created_at TIMESTAMP DEFAULT NOW(),
    resolved BOOLEAN DEFAULT FALSE,
    assignment_id INTEGER REFERENCES assigned_predictions(id),
    UNIQUE(user_id, prediction_id) -- One bet per prediction per user
);

-- Likes table
CREATE TABLE IF NOT EXISTS likes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, post_id) -- Ensure a user can only like a post once
);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('like', 'comment', 'follow', 'mention', 'reply')),
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id INTEGER, -- ID of the post/comment/user that was acted upon
    target_type VARCHAR(20) CHECK (target_type IN ('post', 'comment', 'user')),
    content TEXT, -- Optional message or details
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Score slices table (for unified log scoring)
CREATE TABLE IF NOT EXISTS score_slices (
    id SERIAL PRIMARY KEY,
    prediction_id INTEGER REFERENCES predictions(id) ON DELETE CASCADE,
    slice_start TIMESTAMP NOT NULL,
    slice_end TIMESTAMP NOT NULL,
    raw_loss DECIMAL(10,6), -- Log loss value for this time slice
    time_weight DECIMAL(8,6), -- Weight for this time slice (Δt / T_open)
    created_at TIMESTAMP DEFAULT NOW()
);

-- User reputation table
CREATE TABLE IF NOT EXISTS user_reputation (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rep_points DECIMAL(8,4) DEFAULT 1.0, -- Reputation points (1-11 scale)
    global_rank INTEGER DEFAULT NULL, -- Zero-sum relative ranking (1 = best)
    time_weighted_score DECIMAL(10,6) DEFAULT 0.0, -- Accumulated time-weighted log loss
    peer_bonus DECIMAL(8,6) DEFAULT 0.0, -- Bonus for beating crowd consensus
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- INDEXES --

-- Indexes for predictions
CREATE INDEX IF NOT EXISTS idx_predictions_type ON predictions(prediction_type);
CREATE INDEX IF NOT EXISTS idx_predictions_log_loss ON predictions(raw_log_loss);
CREATE INDEX IF NOT EXISTS idx_predictions_prob_vector ON predictions USING GIN(prob_vector);

-- Indexes for events
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

-- Indexes for notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_actor_id ON notifications(actor_id);
CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications(target_id, target_type);

-- Indexes for scoring system
CREATE INDEX IF NOT EXISTS idx_score_slices_prediction ON score_slices(prediction_id);
CREATE INDEX IF NOT EXISTS idx_user_reputation_points ON user_reputation(rep_points DESC);
CREATE INDEX IF NOT EXISTS idx_user_reputation_rank ON user_reputation(global_rank ASC);

-- TRIGGERS --

-- Trigger to update denormalized like counts
DROP TRIGGER IF EXISTS after_like_insert_or_delete ON likes;
CREATE OR REPLACE FUNCTION update_post_like_count()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        UPDATE posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE posts SET like_count = like_count - 1 WHERE id = OLD.post_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_like_insert_or_delete
AFTER INSERT OR DELETE ON likes
FOR EACH ROW
EXECUTE FUNCTION update_post_like_count();

-- CONSTRAINTS --

-- Add constraint to prevent self-notifications
ALTER TABLE notifications ADD CONSTRAINT check_no_self_notification 
    CHECK (user_id != actor_id);

-- Add constraint to prevent self-follows
ALTER TABLE follows ADD CONSTRAINT check_no_self_follow
    CHECK (follower_id != following_id);

-- LMSR MARKET TABLES --

-- Add market fields to events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS
    market_prob DECIMAL(10,6) DEFAULT 0.5,
    liquidity_b DECIMAL(10,2) DEFAULT 5000.0,
    cumulative_stake DECIMAL(15,2) DEFAULT 0.0,
    q_yes DECIMAL(15,6) DEFAULT 0.0,  -- For AMM tracking (future use)
    q_no DECIMAL(15,6) DEFAULT 0.0;    -- For AMM tracking (future use)

-- Add RP (Reputation Points) fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS
    rp_balance DECIMAL(15,2) DEFAULT 1000.0,
    rp_staked DECIMAL(15,2) DEFAULT 0.0;

-- Track market updates/trades
CREATE TABLE IF NOT EXISTS market_updates (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    prev_prob DECIMAL(10,6) NOT NULL,
    new_prob DECIMAL(10,6) NOT NULL,
    stake_amount DECIMAL(10,2) NOT NULL CHECK (stake_amount > 0),
    shares_acquired DECIMAL(15,6) NOT NULL CHECK (shares_acquired > 0),
    share_type VARCHAR(10) NOT NULL CHECK (share_type IN ('yes', 'no')),
    hold_until TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for market_updates
CREATE INDEX idx_market_updates_user ON market_updates(user_id);
CREATE INDEX idx_market_updates_event ON market_updates(event_id);
CREATE INDEX idx_market_updates_created ON market_updates(created_at DESC);

-- Track user share holdings
CREATE TABLE IF NOT EXISTS user_shares (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    yes_shares DECIMAL(15,6) DEFAULT 0 CHECK (yes_shares >= 0),
    no_shares DECIMAL(15,6) DEFAULT 0 CHECK (no_shares >= 0),
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, event_id)
);

-- Create index for user_shares
CREATE INDEX idx_user_shares_event ON user_shares(event_id);

-- Create a trigger to update last_updated timestamp
CREATE OR REPLACE FUNCTION update_user_shares_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_updated = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_shares_update_timestamp
    BEFORE UPDATE ON user_shares
    FOR EACH ROW
    EXECUTE FUNCTION update_user_shares_timestamp();

-- Create a view for easy market summary
CREATE OR REPLACE VIEW market_summary AS
SELECT 
    e.id AS event_id,
    e.title,
    e.market_prob,
    e.cumulative_stake,
    e.liquidity_b,
    COUNT(DISTINCT mu.user_id) AS unique_traders,
    COUNT(mu.id) AS total_trades,
    COALESCE(SUM(us.yes_shares), 0) AS total_yes_shares,
    COALESCE(SUM(us.no_shares), 0) AS total_no_shares
FROM events e
LEFT JOIN market_updates mu ON e.id = mu.event_id
LEFT JOIN user_shares us ON e.id = us.event_id
WHERE e.market_prob IS NOT NULL
GROUP BY e.id, e.title, e.market_prob, e.cumulative_stake, e.liquidity_b;