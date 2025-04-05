// backend/src/controllers/commentController.js
const db = require('../db');

/**
 * Create a new comment on a post
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.createComment = async (req, res) => {
  const { postId } = req.params;
  const { content } = req.body;
  const userId = req.user.id; // Using our auth middleware pattern
  
  try {
    // Check if post exists
    const postCheck = await db.query('SELECT id FROM posts WHERE id = $1', [postId]);
    
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    // Insert comment - trigger will update comment_count in posts table
    const result = await db.query(
      `INSERT INTO comments (post_id, user_id, content) 
       VALUES ($1, $2, $3) RETURNING *`,
       [postId, userId, content]
    );
    
    // Get username for the response
    const userResult = await db.query(
      'SELECT username FROM users WHERE id = $1',
      [userId]
    );
    
    const commentWithUser = {
      ...result.rows[0],
      username: userResult.rows[0]?.username || 'Unknown User'
    };
    
    res.status(201).json({
      message: 'Comment created successfully',
      comment: commentWithUser
    });
  } catch (error) {
    console.error('Error creating comment:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Retrieve all comments for a post
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getComments = async (req, res) => {
  const { postId } = req.params;
  
  try {
    // Check if post exists
    const postCheck = await db.query('SELECT id FROM posts WHERE id = $1', [postId]);
    
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    // Join with users to get usernames
    const result = await db.query(
      `SELECT c.*, u.username 
       FROM comments c
       LEFT JOIN users u ON c.user_id = u.id
       WHERE c.post_id = $1 
       ORDER BY c.created_at DESC`,
      [postId]
    );
    
    res.status(200).json({
      comments: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Update a comment
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.updateComment = async (req, res) => {
  const { commentId } = req.params;
  const { content } = req.body;
  const userId = req.user.id;

  try {
    // Verify comment exists and belongs to user
    const commentCheck = await db.query(
      'SELECT * FROM comments WHERE id = $1',
      [commentId]
    );
    
    if (commentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Comment not found' });
    }
    
    const comment = commentCheck.rows[0];
    
    // Check if user owns the comment or is admin
    if (comment.user_id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to update this comment' });
    }
    
    // Update the comment
    const result = await db.query(
      `UPDATE comments 
       SET content = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
       [content, commentId]
    );
    
    res.status(200).json({
      message: 'Comment updated successfully',
      comment: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating comment:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Delete a comment
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.deleteComment = async (req, res) => {
  const { commentId } = req.params;
  const userId = req.user.id;
  
  try {
    // Verify comment exists and belongs to user
    const commentCheck = await db.query(
      'SELECT * FROM comments WHERE id = $1',
      [commentId]
    );
    
    if (commentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Comment not found' });
    }
    
    const comment = commentCheck.rows[0];
    
    // Check if user owns the comment or is admin
    if (comment.user_id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to delete this comment' });
    }
    
    // Delete the comment - trigger will update comment_count in posts table
    await db.query(
      'DELETE FROM comments WHERE id = $1',
      [commentId]
    );
    
    res.status(200).json({ message: 'Comment deleted successfully' });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ message: 'Server error' });
  }
};