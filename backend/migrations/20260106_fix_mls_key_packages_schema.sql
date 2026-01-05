-- Fix mls_key_packages schema to match mlsService.js expectations
-- Date: 2026-01-06
-- This migration drops and recreates the table with the correct schema

-- Drop old table (it has wrong column names)
DROP TABLE IF EXISTS mls_key_packages CASCADE;

-- Recreate with correct schema matching mlsService.js
CREATE TABLE mls_key_packages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL DEFAULT 'default',
  package_data BYTEA NOT NULL,
  hash TEXT NOT NULL,
  not_before TIMESTAMP WITH TIME ZONE,
  not_after TIMESTAMP WITH TIME ZONE,
  is_last_resort BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_mls_kp_user ON mls_key_packages(user_id);
CREATE INDEX idx_mls_kp_user_device ON mls_key_packages(user_id, device_id);
CREATE INDEX idx_mls_kp_validity ON mls_key_packages(user_id, not_after);

-- Unique constraint for last-resort key packages (one per user+device)
CREATE UNIQUE INDEX idx_mls_kp_last_resort ON mls_key_packages(user_id, device_id) WHERE is_last_resort = true;

-- Unique index on hash for ON CONFLICT DO NOTHING
CREATE UNIQUE INDEX idx_mls_kp_hash ON mls_key_packages(hash);
