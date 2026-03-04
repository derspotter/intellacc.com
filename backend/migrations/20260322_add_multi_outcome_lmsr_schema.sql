-- Multi-outcome LMSR schema: supports multiple_choice and bucketed numeric markets.

CREATE TABLE IF NOT EXISTS event_outcomes (
    id BIGSERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    outcome_key VARCHAR(64) NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    lower_bound DOUBLE PRECISION,
    upper_bound DOUBLE PRECISION,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, outcome_key)
);

CREATE INDEX IF NOT EXISTS idx_event_outcomes_event_sort
    ON event_outcomes(event_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_event_outcomes_event_active
    ON event_outcomes(event_id, is_active);

CREATE TABLE IF NOT EXISTS event_outcome_states (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    outcome_id BIGINT NOT NULL REFERENCES event_outcomes(id) ON DELETE CASCADE,
    q_value DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    prob DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, outcome_id)
);

CREATE TABLE IF NOT EXISTS user_outcome_shares (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    outcome_id BIGINT NOT NULL REFERENCES event_outcomes(id) ON DELETE CASCADE,
    shares DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    staked_ledger BIGINT NOT NULL DEFAULT 0,
    realized_pnl_ledger BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, event_id, outcome_id),
    CONSTRAINT user_outcome_shares_non_negative CHECK (shares >= 0.0),
    CONSTRAINT user_outcome_staked_non_negative CHECK (staked_ledger >= 0),
    CONSTRAINT user_outcome_version_positive CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_user_outcome_shares_event
    ON user_outcome_shares(event_id);

CREATE INDEX IF NOT EXISTS idx_user_outcome_shares_user_event
    ON user_outcome_shares(user_id, event_id);

CREATE TABLE IF NOT EXISTS market_outcome_updates (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    outcome_id BIGINT NOT NULL REFERENCES event_outcomes(id) ON DELETE CASCADE,
    prev_prob DOUBLE PRECISION NOT NULL,
    new_prob DOUBLE PRECISION NOT NULL,
    stake_amount DOUBLE PRECISION NOT NULL CHECK (stake_amount > 0),
    stake_amount_ledger BIGINT NOT NULL DEFAULT 0 CHECK (stake_amount_ledger >= 0),
    shares_acquired DOUBLE PRECISION NOT NULL CHECK (shares_acquired > 0),
    hold_until TIMESTAMPTZ NOT NULL,
    referral_post_id INTEGER,
    referral_click_id INTEGER,
    had_prior_position BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_outcome_updates_event_created
    ON market_outcome_updates(event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_outcome_updates_user_created
    ON market_outcome_updates(user_id, created_at DESC);

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS resolution_outcome_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name = 'events'
          AND constraint_name = 'events_resolution_outcome_id_fkey'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_resolution_outcome_id_fkey
            FOREIGN KEY (resolution_outcome_id) REFERENCES event_outcomes(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_resolution_outcome
    ON events(resolution_outcome_id);

-- Backfill binary outcomes for existing binary events.
INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
SELECT e.id, 'yes', 'YES', 0
FROM events e
WHERE COALESCE(e.event_type, 'binary') = 'binary'
  AND NOT EXISTS (
      SELECT 1 FROM event_outcomes eo WHERE eo.event_id = e.id AND eo.outcome_key = 'yes'
  );

INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
SELECT e.id, 'no', 'NO', 1
FROM events e
WHERE COALESCE(e.event_type, 'binary') = 'binary'
  AND NOT EXISTS (
      SELECT 1 FROM event_outcomes eo WHERE eo.event_id = e.id AND eo.outcome_key = 'no'
  );

INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
SELECT
    e.id,
    eo.id,
    CASE
        WHEN eo.outcome_key = 'yes' THEN COALESCE(e.q_yes, 0.0)
        WHEN eo.outcome_key = 'no' THEN COALESCE(e.q_no, 0.0)
        ELSE 0.0
    END,
    CASE
        WHEN eo.outcome_key = 'yes' THEN GREATEST(LEAST(COALESCE(e.market_prob, 0.5), 1.0), 0.0)
        WHEN eo.outcome_key = 'no' THEN GREATEST(LEAST(1.0 - COALESCE(e.market_prob, 0.5), 1.0), 0.0)
        ELSE 0.0
    END
FROM events e
JOIN event_outcomes eo ON eo.event_id = e.id
WHERE COALESCE(e.event_type, 'binary') = 'binary'
  AND eo.outcome_key IN ('yes', 'no')
  AND NOT EXISTS (
      SELECT 1
      FROM event_outcome_states eos
      WHERE eos.event_id = e.id AND eos.outcome_id = eo.id
  );
