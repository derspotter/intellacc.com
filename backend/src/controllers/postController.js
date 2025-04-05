const db = require('../db');

// Create a new post or comment
exports.createPost = async (req, res) => {
  try {
    const { content, image_url, parent_id } = req.body;
    
    // Input validation
    if (!content || content.trim() === '') {
      return res.status(400).json({ message: 'Content is required' });
    }
    
    // Get user ID from authenticated user
    const userId = req.user.id;
    
    // Default values for a regular post
    let parentId = null;
    let depth = 0;
    let isComment = false;
    let postId = null;
    
    // If parent_id exists, this is a comment
    if (parent_id) {
      // Verify parent exists and get its depth
      const parentResult = await db.query('SELECT * FROM posts WHERE id = $1', [parent_id]);
      
      if (parentResult.rows.length === 0) {
        return res.status(404).json({ message: 'Parent post not found' });
      }
      
      const parentPost = parentResult.rows[0];
      parentId = parent_id;
      depth = parentPost.depth + 1;
      isComment = true;
      postId = parentPost.id;
    }
    
    console.log('Creating post/comment with:', { userId, content, image_url, parentId, depth, isComment });
    
    // Insert the post or comment
    const result = await db.query(
      'INSERT INTO posts (user_id, content, image_url, parent_id, depth, is_comment, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *',
      [userId, content, image_url, parentId, depth, isComment]
    );
    
    const newPost = result.rows[0];

    // If this is a comment, increment the parent's comment_count
    if (parentId) {
      await db.query(
        'UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1',
        [parentId]
      );
      
      // Handle via socket.io for real-time updates
      if (req.io) {
        req.io.to(`post:${parentId}`).emit('new_comment', newPost);
      }
    } else if (req.io) {
      // Emit new post event for timeline updates
      req.io.emit('new_post', newPost);
    }

    console.log('Post/comment created successfully:', newPost);
    res.status(201).json(newPost);
  } catch (error) {
    console.error('Error in createPost controller:', error);
    console.error('Stack trace:', error.stack);
    
    // Send detailed error in development, but hide details in production
    if (process.env.NODE_ENV === 'development') {
      res.status(500).json({ 
        message: 'Error creating post/comment', 
        error: error.message,
        stack: error.stack 
      });
    } else {
      res.status(500).json({ message: 'Error creating post/comment' });
    }
  }
};

// Retrieve all top-level posts (e.g., a feed)
exports.getPosts = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, u.username 
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.parent_id IS NULL AND p.is_comment = FALSE
       ORDER BY p.created_at DESC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching posts' });
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
  const userId = req.user.id; // Using standardized user object
  
  try {
    const result = await db.query(
      `SELECT p.*, u.username
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE (p.user_id IN (
         SELECT following_id 
         FROM follows 
         WHERE follower_id = $1
       )
       OR p.user_id = $1)
       AND p.parent_id IS NULL
       AND p.is_comment = FALSE
       ORDER BY p.created_at DESC`,
      [userId]
    );
    
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error getting feed:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get comments for a post (direct replies only)
exports.getComments = async (req, res) => {
  const postId = req.params.id;
  
  try {
    // Verify post exists
    const postCheck = await db.query('SELECT * FROM posts WHERE id = $1', [postId]);
    
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    // Get direct comments for this post
    const result = await db.query(
      `SELECT p.*, u.username, u.profile_image 
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.parent_id = $1
       ORDER BY p.created_at ASC`,
      [postId]
    );
    
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ message: 'Error fetching comments' });
  }
};

// Get a full comment tree (with nesting) for a post
exports.getCommentTree = async (req, res) => {
  const postId = req.params.id;
  const maxDepth = req.query.maxDepth ? parseInt(req.query.maxDepth, 10) : 10; // Default max depth to 10
  
  try {
    // Verify post exists
    const postCheck = await db.query('SELECT * FROM posts WHERE id = $1', [postId]);
    
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    // Get all comments for this post with their depth, up to maxDepth
    const result = await db.query(
      `WITH RECURSIVE comment_tree AS (
         -- Base case: direct replies to the post
         SELECT 
           p.*, 
           u.username, 
           u.profile_image,
           1 AS level
         FROM posts p
         JOIN users u ON p.user_id = u.id
         WHERE p.parent_id = $1
         
         UNION ALL
         
         -- Recursive case: replies to comments
         SELECT 
           p.*, 
           u.username, 
           u.profile_image,
           ct.level + 1
         FROM posts p
         JOIN users u ON p.user_id = u.id
         JOIN comment_tree ct ON p.parent_id = ct.id
         WHERE ct.level < $2
       )
       SELECT * FROM comment_tree
       ORDER BY level ASC, created_at ASC`,
      [postId, maxDepth]
    );
    
    // Organize comments into a nested structure
    const commentMap = {};
    const rootComments = [];
    
    // First pass: create a map of all comments
    result.rows.forEach(comment => {
      comment.replies = [];
      commentMap[comment.id] = comment;
    });
    
    // Second pass: build the tree structure
    result.rows.forEach(comment => {
      // Direct replies to the post
      if (comment.parent_id === parseInt(postId)) {
        rootComments.push(comment);
      } else {
        // Replies to comments
        if (commentMap[comment.parent_id]) {
          commentMap[comment.parent_id].replies.push(comment);
        }
      }
    });
    
    res.status(200).json(rootComments);
  } catch (error) {
    console.error('Error fetching comment tree:', error);
    res.status(500).json({ message: 'Error fetching comment tree' });
  }
};