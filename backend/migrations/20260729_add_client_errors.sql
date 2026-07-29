-- Self-hosted error tracking: browser errors reported via POST /api/errors.
-- Read by scripts/error-digest.sh (daily mail to kontakt@); rows older than
-- 30 days are pruned by the same script.
CREATE TABLE IF NOT EXISTS client_errors (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  stack TEXT,
  url TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_errors_created ON client_errors (created_at);
