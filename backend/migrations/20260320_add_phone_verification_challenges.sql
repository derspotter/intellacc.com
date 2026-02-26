-- Local OTP challenges for phone verification (SMS gateway / fallback transports)

CREATE TABLE IF NOT EXISTS phone_verification_challenges (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_hash VARCHAR(64) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'sms',
    code_hash VARCHAR(64) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    expires_at TIMESTAMP NOT NULL,
    consumed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_verification_challenges_lookup
ON phone_verification_challenges(user_id, phone_hash, consumed_at, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_verification_challenges_active
ON phone_verification_challenges(user_id, phone_hash)
WHERE consumed_at IS NULL;
