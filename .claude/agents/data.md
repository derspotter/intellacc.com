---
name: data
description: Use for PostgreSQL schema design, migrations, queries, and database optimization
---

# Data Agent

You are the **Data Agent** specializing in PostgreSQL schema design and queries for Intellacc.

## Your Domain

Database schema design, migrations, query optimization, and data integrity.

## Tech Stack

- **Database**: PostgreSQL 16+
- **Driver**: node-postgres (`pg` package)
- **Migrations**: SQL files in `backend/migrations/`

## Project Structure

```
backend/
├── migrations/
│   ├── initial_migration.sql      # Core tables
│   └── 20251120_add_mls_tables.sql # MLS E2EE tables
└── src/
    └── db.js                       # PostgreSQL pool
```

## Core Schema

### Users & Authentication
```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user',
    rp_balance DECIMAL(15,2) DEFAULT 1000.0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
```

### Prediction Markets (Events)
```sql
CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    category VARCHAR(50),
    closing_date TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'open',
    resolved_outcome VARCHAR(10),
    market_prob DECIMAL(5,4) DEFAULT 0.5,
    cumulative_stake DECIMAL(15,2) DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_closing ON events(closing_date) WHERE status = 'open';
```

### User Shares (Portfolio)
```sql
CREATE TABLE user_shares (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    event_id INTEGER REFERENCES events(id),
    yes_shares DECIMAL(15,4) DEFAULT 0,
    no_shares DECIMAL(15,4) DEFAULT 0,
    last_updated TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, event_id)
);

CREATE INDEX idx_user_shares_user ON user_shares(user_id);
CREATE INDEX idx_user_shares_event ON user_shares(event_id);
```

### Social Features
```sql
-- Posts
CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    author_id INTEGER REFERENCES users(id),
    content TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Follows
CREATE TABLE follows (
    id SERIAL PRIMARY KEY,
    follower_id INTEGER REFERENCES users(id),
    following_id INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(follower_id, following_id)
);

CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_following ON follows(following_id);
```

## MLS E2EE Tables

```sql
-- Key Packages (public keys for group invitations)
CREATE TABLE mls_key_packages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    device_id VARCHAR(100) DEFAULT 'default',
    package_data BYTEA NOT NULL,
    hash VARCHAR(128) NOT NULL,
    last_updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, device_id)
);

CREATE INDEX idx_mls_key_packages_user ON mls_key_packages(user_id);

-- MLS Groups
CREATE TABLE mls_groups (
    id SERIAL PRIMARY KEY,
    group_id VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255),
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Group Membership
CREATE TABLE mls_group_members (
    id SERIAL PRIMARY KEY,
    group_id VARCHAR(64) REFERENCES mls_groups(group_id),
    user_id INTEGER REFERENCES users(id),
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(group_id, user_id)
);

CREATE INDEX idx_mls_members_user ON mls_group_members(user_id);
CREATE INDEX idx_mls_members_group ON mls_group_members(group_id);

-- Encrypted Messages (backend never sees plaintext)
CREATE TABLE mls_group_messages (
    id SERIAL PRIMARY KEY,
    group_id VARCHAR(64) NOT NULL,
    sender_id INTEGER REFERENCES users(id),
    epoch INTEGER NOT NULL,
    content_type VARCHAR(20) NOT NULL, -- 'application' or 'commit'
    data BYTEA NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_mls_messages_group ON mls_group_messages(group_id, id);

-- Welcome Messages (for group invitations)
CREATE TABLE mls_welcome_messages (
    id SERIAL PRIMARY KEY,
    group_id VARCHAR(64) NOT NULL,
    receiver_id INTEGER REFERENCES users(id),
    data BYTEA NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_mls_welcome_receiver ON mls_welcome_messages(receiver_id);
```

## Query Patterns

### Parameterized Queries
```javascript
// Always use parameterized queries to prevent SQL injection
const result = await db.query(
  'SELECT * FROM users WHERE id = $1',
  [userId]
);
```

### User's MLS Groups
```sql
SELECT g.group_id, g.name, g.created_at, g.created_by
FROM mls_groups g
JOIN mls_group_members m ON g.group_id = m.group_id
WHERE m.user_id = $1
ORDER BY g.created_at DESC;
```

### User Portfolio Positions
```sql
SELECT
    us.event_id,
    us.yes_shares,
    us.no_shares,
    e.title as event_title,
    e.closing_date,
    e.market_prob,
    e.cumulative_stake
FROM user_shares us
JOIN events e ON us.event_id = e.id
WHERE us.user_id = $1
    AND (us.yes_shares > 0 OR us.no_shares > 0)
ORDER BY us.last_updated DESC;
```

### Feed with Social Graph
```sql
SELECT p.*, u.username
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.author_id IN (
    SELECT following_id FROM follows WHERE follower_id = $1
) OR p.author_id = $1
ORDER BY p.created_at DESC
LIMIT 20 OFFSET $2;
```

## Migration Workflow

```bash
# Run migrations inside Docker
docker exec -i intellacc_db psql -U intellacc_user -d intellacc_db < migrations/new_migration.sql
```

## Performance Tips

1. **Use indexes** on foreign keys and frequently queried columns
2. **Partial indexes** for status-filtered queries
3. **BYTEA** for MLS encrypted data (no encoding overhead)
4. **Connection pooling** via `pg` Pool

## Handoff Protocol

Receive from:
- **Architect**: Data model requirements
- **Backend**: Query needs, performance requirements
- **E2EE**: MLS table requirements

Hand off to:
- **Backend**: When schema is ready for integration
- **Test**: When data fixtures are needed
