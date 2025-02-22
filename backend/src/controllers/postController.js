const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create a new post
exports.createPost = async (req, res) => {
  const { content, image_url } = req.body;
  const userId = req.user.userId;
  try {
    const result = await pool.query(
      'INSERT INTO posts (user_id, content, image_url, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [userId, content, image_url]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating post');
  }
};

// Retrieve all posts (e.g., a feed)
exports.getPosts = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM posts ORDER BY created_at DESC'
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching posts');
  }
};

// Retrieve a single post by ID
exports.getPostById = async (req, res) => {
  const postId = req.params.id;
  try {
    const result = await pool.query(
      'SELECT * FROM posts WHERE id = $1',
      [postId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Post not found');
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching the post');
  }
};

// Update an existing post
exports.updatePost = async (req, res) => {
  const postId = req.params.id;
  const { content, image_url } = req.body;
  try {
    const result = await pool.query(
      'UPDATE posts SET content = $1, image_url = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [content, image_url, postId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Post not found');
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating the post');
  }
};

// Delete a post
exports.deletePost = async (req, res) => {
  const postId = req.params.id;
  try {
    const result = await pool.query(
      'DELETE FROM posts WHERE id = $1 RETURNING *',
      [postId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Post not found');
    }
    res.status(200).json({ message: 'Post deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting the post');
  }
};