const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create a new comment on a post
exports.createComment = async (req, res) => {
  const { postId } = req.params;
  const { content } = req.body;
  const userId = req.user.userId;
  
  try {
    const result = await pool.query(
      `INSERT INTO comments (post_id, user_id, content, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING *`,
       [postId, userId, content]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating comment');
  }
};

// Retrieve all comments for a post
exports.getComments = async (req, res) => {
  const { postId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at ASC',
      [postId]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching comments');
  }
};

// Update a comment
exports.updateComment = async (req, res) => {
  const { postId, commentId } = req.params;
  const { content } = req.body;

  try {
    const result = await pool.query(
      `UPDATE comments 
         SET content = $1, updated_at = NOW()
       WHERE id = $2 AND post_id = $3
       RETURNING *`,
       [content, commentId, postId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Comment not found');
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating comment');
  }
};

// Delete a comment
exports.deleteComment = async (req, res) => {
  const { postId, commentId } = req.params;
  
  try {
    const result = await pool.query(
      'DELETE FROM comments WHERE id = $1 AND post_id = $2 RETURNING *',
      [commentId, postId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Comment not found');
    }
    res.status(200).json({ message: 'Comment deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting comment');
  }
};