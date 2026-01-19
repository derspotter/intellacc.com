-- Password reset requests (delayed reset flow)
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, cancelled, completed
  required_confirmations INT NOT NULL DEFAULT 0,
  confirmed_at TIMESTAMP,
  execute_after TIMESTAMP NOT NULL,
  new_password_hash TEXT NOT NULL,
  token_id INTEGER REFERENCES password_reset_tokens(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_requests_user ON password_reset_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_status ON password_reset_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_requests_pending
  ON password_reset_requests(user_id)
  WHERE status = 'pending';
