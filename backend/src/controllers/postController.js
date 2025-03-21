const db = require('../db');

// Create a new post
exports.createPost = async (req, res) => {
  try {
    const { content, image_url } = req.body;
    
    // Input validation
    if (!content || content.trim() === '') {
      return res.status(400).json({ message: 'Content is required' });
    }
    
    // Get user ID from authenticated user
    const userId = req.user.id;
    
    console.log('Creating post with:', { userId, content, image_url });
    
    const result = await db.query(
      'INSERT INTO posts (user_id, content, image_url, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
      [userId, content, image_url]
    );
    
    const newPost = result.rows[0];

    // Post creation is now handled solely through REST API
    // No Socket.IO events are emitted for post creation
    // Socket.IO will be reserved for notifications and other real-time features

    console.log('Post created successfully:', newPost);
    res.status(201).json(newPost);
  } catch (error) {
    console.error('Error in createPost controller:', error);
    console.error('Stack trace:', error.stack);
    
    // Send detailed error in development, but hide details in production
    if (process.env.NODE_ENV === 'development') {
      res.status(500).json({ 
        message: 'Error creating post', 
        error: error.message,
        stack: error.stack 
      });
    } else {
      res.status(500).json({ message: 'Error creating post' });
    }
  }
};

// Retrieve all posts (e.g., a feed)
exports.getPosts = async (req, res) => {
  try {
    const result = await db.query(
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
    const result = await db.query(
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
    const result = await db.query(
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
    const result = await db.query(
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

// Get personalized feed of posts from followed users
exports.getFeed = async (req, res) => {
  const userId = req.user.userId;
  
  try {
    const result = await db.query(
      `SELECT p.*, u.username
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.user_id IN (
         SELECT following_id 
         FROM follows 
         WHERE follower_id = $1
       )
       OR p.user_id = $1
       ORDER BY p.created_at DESC`,
      [userId]
    );
    
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error getting feed:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};