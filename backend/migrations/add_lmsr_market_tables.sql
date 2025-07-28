-- Add LMSR market functionality to the prediction platform

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

-- Create indexes
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

-- Create index
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

-- Initialize existing events with default market values
UPDATE events 
SET market_prob = 0.5, 
    liquidity_b = 5000.0, 
    cumulative_stake = 0.0
WHERE market_prob IS NULL;

-- Initialize existing users with default RP balance
UPDATE users 
SET rp_balance = 1000.0, 
    rp_staked = 0.0
WHERE rp_balance IS NULL;