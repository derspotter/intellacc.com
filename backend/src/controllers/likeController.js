// backend/src/controllers/likeController.js
const db = require('../db');

/**
 * Like a post
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.likePost = async (req, res) => {
  const { postId } = req.params;
  const userId = req.user.id;

  try {
    // Check if post exists
    const postResult = await db.query(
      'SELECT * FROM posts WHERE id = $1',
      [postId]
    );

    if (postResult.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if already liked
    const likeCheck = await db.query(
      'SELECT * FROM likes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );

    if (likeCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Post already liked' });
    }

    // Add like - this will trigger the database function to update the like_count
    const result = await db.query(
      'INSERT INTO likes (user_id, post_id) VALUES ($1, $2) RETURNING *',
      [userId, postId]
    );

    // Get the post with updated like count
    const updatedPost = await db.query(
      'SELECT like_count FROM posts WHERE id = $1',
      [postId]
    );

    return res.status(201).json({
      message: 'Post liked successfully',
      like: result.rows[0],
      likeCount: updatedPost.rows[0].like_count
    });
  } catch (error) {
    console.error('Error liking post:', error);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Unlike a post
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.unlikePost = async (req, res) => {
  const { postId } = req.params;
  const userId = req.user.id;

  try {
    // Check if post exists
    const postResult = await db.query(
      'SELECT * FROM posts WHERE id = $1',
      [postId]
    );

    if (postResult.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if like exists
    const likeCheck = await db.query(
      'SELECT * FROM likes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );

    if (likeCheck.rows.length === 0) {
      return res.status(400).json({ message: 'Post is not liked' });
    }

    // Remove like - this will trigger the database function to update the like_count
    await db.query(
      'DELETE FROM likes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );

    // Get the post with updated like count
    const updatedPost = await db.query(
      'SELECT like_count FROM posts WHERE id = $1',
      [postId]
    );

    return res.status(200).json({
      message: 'Post unliked successfully',
      likeCount: updatedPost.rows[0].like_count
    });
  } catch (error) {
    console.error('Error unliking post:', error);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Check if user has liked a post
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.checkLikeStatus = async (req, res) => {
  const { postId } = req.params;
  const userId = req.user.id;

  try {
    // Get post with like count and check if user has liked it in one query
    const postAndLikeInfo = await db.query(
      `SELECT p.*, 
              CASE WHEN EXISTS (SELECT 1 FROM likes 
                                WHERE post_id = $1 AND user_id = $2) 
                   THEN true 
                   ELSE false 
              END AS liked_by_user
       FROM posts p 
       WHERE p.id = $1`,
      [postId, userId]
    );

    if (postAndLikeInfo.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const post = postAndLikeInfo.rows[0];

    return res.status(200).json({
      liked: post.liked_by_user,  // Keep 'liked' for backward compatibility with existing code
      isLiked: post.liked_by_user, // Also include isLiked since we've updated the store to use this
      likeCount: post.like_count
    });
  } catch (error) {
    console.error('Error checking like status:', error);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Get likes count for post
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getLikesCount = async (req, res) => {
  const { postId } = req.params;

  try {
    // Get post with like count in one query
    const post = await db.query(
      'SELECT like_count FROM posts WHERE id = $1',
      [postId]
    );

    if (post.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    return res.status(200).json({
      likeCount: post.rows[0].like_count
    });
  } catch (error) {
    console.error('Error getting likes count:', error);
    return res.status(500).json({ message: 'Server error' });
  }
};
