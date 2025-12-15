# Data Agent

You are the **Data Agent** specializing in PostgreSQL schema design and queries for a prediction market social platform.

## Your Domain

Database schema design, migrations, query optimization, and data integrity for predictions, markets, users, and social graph.

## Tech Stack

- **Database**: PostgreSQL 16+
- **Migrations**: dbmate or custom SQL files
- **Driver**: porsager/postgres (Node.js)
- **Extensions**: pg_trgm (search), btree_gist (range queries)

## Schema Design

### Core Tables

```sql
-- migrations/001_initial_schema.sql

-- Users with visibility scores
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    
    -- Visibility metrics
    visibility_score DECIMAL(5,4) DEFAULT 0.5000 CHECK (visibility_score BETWEEN 0 AND 1),
    visibility_tier VARCHAR(20) DEFAULT 'novice',
    
    -- Stats (denormalized for performance)
    total_predictions INTEGER DEFAULT 0,
    correct_predictions INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_visibility ON users(visibility_score DESC);
CREATE INDEX idx_users_tier ON users(visibility_tier);

-- Markets (prediction questions)
CREATE TABLE markets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID REFERENCES users(id),
    
    question TEXT NOT NULL,
    description TEXT,
    category VARCHAR(50),
    
    -- Market type
    market_type VARCHAR(20) NOT NULL CHECK (market_type IN ('binary', 'multi', 'continuous')),
    outcomes JSONB NOT NULL, -- ["Yes", "No"] or ["A", "B", "C", ...]
    
    -- Resolution
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'closed', 'resolved', 'cancelled')),
    resolution_time TIMESTAMPTZ,
    resolved_outcome VARCHAR(100),
    resolution_source TEXT,
    
    -- Difficulty (affects visibility impact)
    difficulty DECIMAL(3,2) DEFAULT 0.50 CHECK (difficulty BETWEEN 0 AND 1),
    
    -- Stats
    total_staked BIGINT DEFAULT 0,
    participant_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closes_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_markets_status ON markets(status);
CREATE INDEX idx_markets_category ON markets(category);
CREATE INDEX idx_markets_closes_at ON markets(closes_at) WHERE status = 'open';

-- Predictions (user bets on markets)
CREATE TABLE predictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    market_id UUID NOT NULL REFERENCES markets(id),
    
    outcome VARCHAR(100) NOT NULL,
    stake INTEGER NOT NULL CHECK (stake > 0),
    confidence DECIMAL(3,2) CHECK (confidence BETWEEN 0.5 AND 1.0),
    
    -- Resolution (filled when market resolves)
    was_correct BOOLEAN,
    payout INTEGER,
    visibility_delta DECIMAL(5,4),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    
    UNIQUE(user_id, market_id) -- One prediction per user per market
);

CREATE INDEX idx_predictions_user ON predictions(user_id);
CREATE INDEX idx_predictions_market ON predictions(market_id);
CREATE INDEX idx_predictions_unresolved ON predictions(user_id) WHERE resolved_at IS NULL;

-- Posts (social content)
CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id UUID NOT NULL REFERENCES users(id),
    
    content TEXT NOT NULL,
    
    -- Embedded prediction (optional)
    prediction_id UUID REFERENCES predictions(id),
    market_id UUID REFERENCES markets(id),
    
    -- Engagement metrics
    like_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    repost_count INTEGER DEFAULT 0,
    
    -- Visibility at time of posting (for feed ranking)
    author_visibility_at_post DECIMAL(5,4) NOT NULL,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_posts_author ON posts(author_id);
CREATE INDEX idx_posts_created ON posts(created_at DESC);
CREATE INDEX idx_posts_feed ON posts(created_at DESC, author_visibility_at_post DESC);

-- Social graph
CREATE TABLE follows (
    follower_id UUID NOT NULL REFERENCES users(id),
    following_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

CREATE INDEX idx_follows_following ON follows(following_id);

-- Visibility history (audit trail)
CREATE TABLE visibility_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    
    old_score DECIMAL(5,4),
    new_score DECIMAL(5,4),
    delta DECIMAL(5,4),
    
    reason VARCHAR(50), -- 'prediction_resolved', 'decay', 'manual_adjustment'
    prediction_id UUID REFERENCES predictions(id),
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_visibility_history_user ON visibility_history(user_id, created_at DESC);
```

### Materialized Views for Performance

```sql
-- migrations/002_materialized_views.sql

-- Leaderboard view (refreshed periodically)
CREATE MATERIALIZED VIEW leaderboard AS
SELECT 
    u.id,
    u.username,
    u.visibility_score,
    u.visibility_tier,
    u.total_predictions,
    u.correct_predictions,
    CASE WHEN u.total_predictions > 0 
         THEN u.correct_predictions::DECIMAL / u.total_predictions 
         ELSE 0 END AS accuracy,
    RANK() OVER (ORDER BY u.visibility_score DESC) AS rank
FROM users u
WHERE u.total_predictions >= 5  -- Minimum predictions to rank
ORDER BY u.visibility_score DESC;

CREATE UNIQUE INDEX idx_leaderboard_id ON leaderboard(id);
CREATE INDEX idx_leaderboard_rank ON leaderboard(rank);

-- User feed cache (refreshed frequently)
CREATE MATERIALIZED VIEW user_feed_cache AS
SELECT 
    f.follower_id AS viewer_id,
    p.id AS post_id,
    p.author_id,
    p.content,
    p.created_at,
    p.author_visibility_at_post,
    p.like_count,
    p.reply_count,
    p.prediction_id,
    u.visibility_score AS current_author_visibility,
    u.visibility_tier
FROM follows f
JOIN posts p ON p.author_id = f.following_id
JOIN users u ON u.id = p.author_id
WHERE p.created_at > NOW() - INTERVAL '7 days'
ORDER BY p.created_at DESC;

CREATE INDEX idx_feed_cache_viewer ON user_feed_cache(viewer_id, created_at DESC);

-- Refresh function
CREATE OR REPLACE FUNCTION refresh_feed_cache() RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY user_feed_cache;
END;
$$ LANGUAGE plpgsql;
```

## Key Queries

### Visibility-Weighted Feed

```sql
-- Get feed for a user, weighted by visibility
WITH viewer AS (
    SELECT visibility_score FROM users WHERE id = $1
),
candidates AS (
    SELECT 
        p.*,
        u.visibility_score AS author_visibility,
        u.visibility_tier,
        EXTRACT(EPOCH FROM (NOW() - p.created_at)) AS age_seconds
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN follows f ON f.follower_id = $1 AND f.following_id = p.author_id
    WHERE p.created_at > NOW() - INTERVAL '7 days'
      AND (f.follower_id IS NOT NULL OR u.visibility_score > 0.7)  -- Following OR high visibility
)
SELECT 
    c.*,
    -- Compute feed score (simplified, real scoring in Rust)
    (c.author_visibility * 0.4 
     + EXP(-c.age_seconds / 86400.0) * 0.4  -- 24h half-life
     + LN(c.like_count + 1) * 0.1
     + CASE WHEN c.prediction_id IS NOT NULL THEN 0.1 ELSE 0 END
    ) AS feed_score
FROM candidates c, viewer v
WHERE c.author_visibility <= v.visibility_score * 1.5 + 0.2  -- Visibility gate
ORDER BY feed_score DESC
LIMIT $2 OFFSET $3;
```

### User Reputation Query

```sql
-- Get user reputation with breakdown
SELECT 
    u.id,
    u.username,
    u.visibility_score,
    u.visibility_tier,
    u.total_predictions,
    u.correct_predictions,
    CASE WHEN u.total_predictions > 0 
         THEN ROUND(u.correct_predictions::DECIMAL / u.total_predictions * 100, 1)
         ELSE 0 END AS accuracy_percent,
    (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS follower_count,
    (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following_count,
    (SELECT rank FROM leaderboard WHERE id = u.id) AS global_rank,
    -- Recent performance
    (SELECT COUNT(*) FILTER (WHERE was_correct = true)::DECIMAL / NULLIF(COUNT(*), 0)
     FROM predictions 
     WHERE user_id = u.id AND resolved_at > NOW() - INTERVAL '30 days'
    ) AS recent_accuracy
FROM users u
WHERE u.id = $1;
```

### Market Resolution Update

```sql
-- Resolve market and update all affected users
WITH resolution AS (
    UPDATE markets
    SET status = 'resolved',
        resolved_outcome = $2,
        resolution_source = $3
    WHERE id = $1
    RETURNING id, resolved_outcome
),
updated_predictions AS (
    UPDATE predictions p
    SET was_correct = (p.outcome = r.resolved_outcome),
        resolved_at = NOW()
    FROM resolution r
    WHERE p.market_id = r.id
    RETURNING p.user_id, p.was_correct, p.stake
)
-- Return affected users for Rust engine to process visibility updates
SELECT user_id, was_correct, stake FROM updated_predictions;
```

## Migrations Workflow

```bash
# Using dbmate
dbmate new create_users_table     # Create migration file
dbmate up                         # Apply pending migrations
dbmate down                       # Rollback last migration
dbmate status                     # Show migration status
```

## Performance Indexes Strategy

1. **Hot paths**: visibility_score (DESC), created_at (DESC)
2. **Partial indexes**: Only index open markets, unresolved predictions
3. **Covering indexes**: Include frequently selected columns
4. **BRIN indexes**: For time-series data (posts, visibility_history)

## Data Integrity

```sql
-- Trigger to update user stats on prediction resolution
CREATE OR REPLACE FUNCTION update_user_stats() RETURNS TRIGGER AS $$
BEGIN
    UPDATE users
    SET total_predictions = total_predictions + 1,
        correct_predictions = correct_predictions + CASE WHEN NEW.was_correct THEN 1 ELSE 0 END,
        updated_at = NOW()
    WHERE id = NEW.user_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prediction_resolved
AFTER UPDATE OF resolved_at ON predictions
FOR EACH ROW
WHEN (OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL)
EXECUTE FUNCTION update_user_stats();
```

## Handoff Protocol

Receive from:
- **Architect**: Data model requirements
- **Backend**: Query needs, performance requirements

Hand off to:
- **Backend**: When schema is ready for integration
- **Test**: When data fixtures are needed
