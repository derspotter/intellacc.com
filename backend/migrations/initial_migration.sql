-- backend/migrations/initial_migration.sql

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

CREATE TABLE IF NOT EXISTS topics (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS user_visibility_score (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    score FLOAT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS follows (
    id SERIAL PRIMARY KEY,
    follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(follower_id, following_id)
);

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

-- Tables for post engagement features
CREATE TABLE IF NOT EXISTS likes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, post_id) -- Ensure a user can only like a post once
);

-- All tables above already have the necessary columns

-- Triggers to update denormalized counts
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

-- Indexes for numerical predictions and event types
CREATE INDEX IF NOT EXISTS idx_predictions_type ON predictions(prediction_type);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

-- Unified log scoring system tables
CREATE TABLE IF NOT EXISTS score_slices (
    id SERIAL PRIMARY KEY,
    prediction_id INTEGER REFERENCES predictions(id) ON DELETE CASCADE,
    slice_start TIMESTAMP NOT NULL,
    slice_end TIMESTAMP NOT NULL,
    raw_loss DECIMAL(10,6), -- Log loss value for this time slice
    time_weight DECIMAL(8,6), -- Weight for this time slice (Δt / T_open)
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_reputation (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rep_points DECIMAL(8,4) DEFAULT 1.0, -- Reputation points (1-11 scale)
    global_rank INTEGER DEFAULT NULL, -- Zero-sum relative ranking (1 = best)
    time_weighted_score DECIMAL(10,6) DEFAULT 0.0, -- Accumulated time-weighted log loss
    peer_bonus DECIMAL(8,6) DEFAULT 0.0, -- Bonus for beating crowd consensus
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for unified scoring system
CREATE INDEX IF NOT EXISTS idx_predictions_log_loss ON predictions(raw_log_loss);
CREATE INDEX IF NOT EXISTS idx_predictions_prob_vector ON predictions USING GIN(prob_vector);
CREATE INDEX IF NOT EXISTS idx_score_slices_prediction ON score_slices(prediction_id);
CREATE INDEX IF NOT EXISTS idx_user_reputation_points ON user_reputation(rep_points DESC);
CREATE INDEX IF NOT EXISTS idx_user_reputation_rank ON user_reputation(global_rank ASC);
