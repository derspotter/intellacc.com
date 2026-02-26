-- 2026-03-13: OpenRouter matching + verification optional schema
--
-- These tables are optional; they provide richer evidence and
-- human-verification workflow once the model-driven matcher is enabled.

BEGIN;

CREATE TABLE IF NOT EXISTS propositions (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  prop_type VARCHAR(30) NOT NULL CHECK (
    prop_type IN ('premise', 'conclusion', 'assumption', 'evidence', 'conditional_antecedent')
  ),
  content TEXT NOT NULL,
  formal TEXT,
  evidence_start INTEGER,
  evidence_end INTEGER,
  confidence_level VARCHAR(30) CHECK (
    confidence_level IN ('assertion', 'prediction', 'speculation', 'question', 'conditional')
  ),
  negated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_props_post ON propositions(post_id);

CREATE TABLE IF NOT EXISTS post_market_links (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  conclusion_prop_id INTEGER REFERENCES propositions(id),
  stance VARCHAR(20) NOT NULL CHECK (stance IN ('agrees', 'disagrees', 'related')),
  match_confidence REAL,
  source VARCHAR(30) NOT NULL CHECK (
    source IN (
      'auto_match',
      'author_confirmed',
      'author_overridden',
      'reader_suggested',
      'reader_flagged_removed'
    )
  ),
  confirmed BOOLEAN DEFAULT FALSE,
  flagged_count INTEGER NOT NULL DEFAULT 0,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_post_market_links_post_event UNIQUE (post_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_pml_post ON post_market_links(post_id);
CREATE INDEX IF NOT EXISTS idx_pml_event ON post_market_links(event_id);

CREATE TABLE IF NOT EXISTS prop_relations (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  from_prop_id INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
  to_prop_id INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
  relation_type VARCHAR(30) NOT NULL CHECK (
    relation_type IN ('supports', 'implies', 'contradicts', 'conditional', 'conjunction', 'disjunction', 'unless')
  ),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_prop_relation UNIQUE (from_prop_id, to_prop_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_relations_post ON prop_relations(post_id);
CREATE INDEX IF NOT EXISTS idx_relations_from ON prop_relations(from_prop_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON prop_relations(to_prop_id);

CREATE TABLE IF NOT EXISTS conditional_flags (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  antecedent_event_id INTEGER NOT NULL REFERENCES events(id),
  consequent_event_id INTEGER NOT NULL REFERENCES events(id),
  antecedent_prop_id INTEGER REFERENCES propositions(id),
  consequent_prop_id INTEGER REFERENCES propositions(id),
  relationship VARCHAR(30) CHECK (
    relationship IN ('positive', 'negative', 'prerequisite')
  ),
  flag_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (antecedent_event_id, consequent_event_id)
);

CREATE INDEX IF NOT EXISTS idx_cf_antecedent ON conditional_flags(antecedent_event_id);
CREATE INDEX IF NOT EXISTS idx_cf_consequent ON conditional_flags(consequent_event_id);

CREATE TABLE IF NOT EXISTS post_critiques (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  critique_type VARCHAR(50) NOT NULL CHECK (
    critique_type IN (
      'unsupported_causal_claim',
      'contradiction',
      'ambiguous_timeframe',
      'unfalsifiable',
      'missing_base_rate',
      'cherry_picked_evidence',
      'false_dichotomy',
      'appeal_to_authority',
      'circular_reasoning',
      'non_sequitur',
      'hasty_generalization'
    )
  ),
  description TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  related_prop_id INTEGER REFERENCES propositions(id),
  evidence_start INTEGER,
  evidence_end INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_critiques_post ON post_critiques(post_id);

CREATE TABLE IF NOT EXISTS verification_actions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  action_type VARCHAR(30) NOT NULL CHECK (
    action_type IN (
      'confirm_market_match',
      'reject_market_match',
      'suggest_market',
      'confirm_logic',
      'reject_logic',
      'flag_critique_helpful',
      'flag_critique_wrong'
    )
  ),
  target_link_id INTEGER REFERENCES post_market_links(id) ON DELETE CASCADE,
  target_event_id INTEGER REFERENCES events(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, post_id, action_type, target_link_id)
);

CREATE INDEX IF NOT EXISTS idx_va_post ON verification_actions(post_id);
CREATE INDEX IF NOT EXISTS idx_va_user ON verification_actions(user_id);

COMMIT;
