-- Add category field to events table for Metaculus categorization
-- Migration: add_category_to_events.sql

-- Add category column to events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS category VARCHAR(100);

-- Create index for category filtering
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);

-- Update existing Metaculus imports to have a default category
UPDATE events 
SET category = 'general' 
WHERE category IS NULL 
AND details LIKE '%Metaculus ID:%';

-- Update non-Metaculus events to have a general category
UPDATE events 
SET category = 'general' 
WHERE category IS NULL;