CREATE TABLE IF NOT EXISTS link_metadata (
  id SERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  description TEXT,
  image_url TEXT,
  site_name TEXT,
  content TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_url TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_metadata_id INTEGER REFERENCES link_metadata(id) ON DELETE SET NULL;
