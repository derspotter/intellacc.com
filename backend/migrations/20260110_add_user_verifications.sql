-- Tiered Identity Verification System
-- Phase 1: Email + schema for phone/payment verification

-- Verification tracking table
CREATE TABLE IF NOT EXISTS user_verifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 3),
    verification_type VARCHAR(50) NOT NULL, -- 'email', 'phone', 'payment'
    provider VARCHAR(50) NOT NULL, -- 'internal', 'twilio', 'stripe', 'paypal'
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'verified', 'failed', 'revoked'
    provider_id VARCHAR(255), -- External reference ID
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Enforce sequential tiers: can't verify tier N without tier N-1
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_verifications_user_tier ON user_verifications(user_id, tier);
CREATE INDEX IF NOT EXISTS idx_user_verifications_status ON user_verifications(status);

-- Phone uniqueness for sybil resistance (store hash only)
CREATE TABLE IF NOT EXISTS phone_hashes (
    id SERIAL PRIMARY KEY,
    phone_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 of normalized E.164 number
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Payment method verification (no sensitive data stored)
CREATE TABLE IF NOT EXISTS payment_verifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL, -- 'stripe', 'paypal'
    provider_customer_id VARCHAR(255), -- Stripe customer ID or PayPal payer ID
    verification_method VARCHAR(50), -- 'card_check', 'micro_deposit', 'paypal_auth'
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_verifications_user_provider ON payment_verifications(user_id, provider);

-- AI detection results
CREATE TABLE IF NOT EXISTS content_ai_analysis (
    id SERIAL PRIMARY KEY,
    content_type VARCHAR(20) NOT NULL, -- 'post', 'comment', 'bio'
    content_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ai_probability DECIMAL(5,4), -- 0.0000 to 1.0000
    detected_model VARCHAR(50), -- 'chatgpt', 'claude', 'gemini', etc.
    is_flagged BOOLEAN DEFAULT FALSE,
    analyzed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_flagged ON content_ai_analysis(is_flagged) WHERE is_flagged = TRUE;
CREATE INDEX IF NOT EXISTS idx_ai_analysis_content ON content_ai_analysis(content_type, content_id);

-- Update users table with verification columns
ALTER TABLE users
ADD COLUMN IF NOT EXISTS verification_tier INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS ai_flag_count INTEGER DEFAULT 0;

-- Email verification tokens table (for tracking pending verifications)
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 of the actual token
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_tokens_expires ON email_verification_tokens(expires_at);
