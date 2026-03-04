CREATE TABLE IF NOT EXISTS event_external_sources (
    id BIGSERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    source VARCHAR(32) NOT NULL,
    external_id TEXT NOT NULL,
    external_url TEXT,
    raw_payload JSONB,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_event_external_sources_event_id
    ON event_external_sources(event_id);

CREATE INDEX IF NOT EXISTS idx_event_external_sources_source_last_seen
    ON event_external_sources(source, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS external_import_runs (
    id BIGSERIAL PRIMARY KEY,
    provider VARCHAR(32) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    excluded_count INTEGER NOT NULL DEFAULT 0,
    merged_count INTEGER NOT NULL DEFAULT 0,
    created_count INTEGER NOT NULL DEFAULT 0,
    linked_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    errors JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_external_import_runs_provider_started
    ON external_import_runs(provider, started_at DESC);
