-- Add repost_id to posts table to allow users to boost/repost other posts
ALTER TABLE posts ADD COLUMN IF NOT EXISTS repost_id INTEGER REFERENCES posts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_posts_repost_id ON posts(repost_id);
