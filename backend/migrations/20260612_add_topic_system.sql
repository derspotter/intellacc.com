-- backend/migrations/20260612_add_topic_system.sql
-- Topic system: user-facing topics, event classification, user preferences.
-- Idempotent: safe to replay.

ALTER TABLE topics ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS embedding vector(768);
ALTER TABLE topics ADD COLUMN IF NOT EXISTS is_user_facing BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS display_order INT;

CREATE UNIQUE INDEX IF NOT EXISTS topics_slug_key ON topics (slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_topics (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    similarity REAL CHECK (similarity IS NULL OR (similarity >= -1.0 AND similarity <= 1.0)),
    source TEXT NOT NULL DEFAULT 'embedding',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_event_topics_topic ON event_topics (topic_id);

CREATE TABLE IF NOT EXISTS user_topics (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_user_topics_topic ON user_topics (topic_id);

INSERT INTO topics (name, slug, description, is_user_facing, display_order) VALUES
('Politics', 'politics', 'Domestic politics: elections, legislation, party leadership, polling, government formation. Example questions: Who wins the next election? Will this bill pass?', TRUE, 1),
('Geopolitics', 'geopolitics', 'International relations, conflicts, diplomacy, treaties, sanctions, territorial disputes. Example questions: Will a ceasefire hold? Will country X join the alliance?', TRUE, 2),
('Economics & Finance', 'economics-finance', 'Macroeconomics, markets, inflation, interest rates, employment, recessions, corporate earnings. Example questions: Will the central bank cut rates? Will GDP growth exceed 2%?', TRUE, 3),
('AI & Technology', 'ai-technology', 'Artificial intelligence, software, hardware, space tech, consumer technology, tech companies. Example questions: Will an AI model pass this benchmark? Will the product launch this year?', TRUE, 4),
('Science', 'science', 'Scientific research and discoveries: physics, biology, medicine research, mathematics, peer-reviewed results. Example questions: Will the experiment replicate? Will the mission detect what it searches for?', TRUE, 5),
('Climate & Environment', 'climate-environment', 'Climate change, emissions, extreme weather, energy transition, environmental policy. Example questions: Will this year be the hottest on record? Will the emissions target be met?', TRUE, 6),
('Health', 'health', 'Public health, pandemics, drug approvals, healthcare policy, epidemiology. Example questions: Will the vaccine be approved? Will cases exceed the threshold?', TRUE, 7),
('Sports', 'sports', 'Professional and international sports: football, basketball, olympics, championships, transfers and records. Example questions: Who wins the championship? Will the record be broken?', TRUE, 8),
('Culture & Media', 'culture-media', 'Film, music, awards, celebrities, social media trends, publishing. Example questions: Which film wins the award? Will the show be renewed?', TRUE, 9),
('Crypto', 'crypto', 'Cryptocurrencies, blockchain, token prices, exchanges, crypto regulation. Example questions: Will bitcoin close above the threshold? Will the ETF be approved?', TRUE, 10)
ON CONFLICT (name) DO UPDATE SET
  slug = EXCLUDED.slug,
  description = EXCLUDED.description,
  is_user_facing = EXCLUDED.is_user_facing,
  display_order = EXCLUDED.display_order;
