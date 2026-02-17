const db = require('../db');
const fs = require('fs');
const path = require('path');
const notificationService = require('../services/notificationService');
const pangramService = require('../services/pangramService');
const activitypubOutbound = require('../services/activitypub/outboundService');
const atprotoOutbound = require('../services/atproto/outboundService');
const { getRequestBaseUrl } = require('../services/activitypub/url');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');

const getViewerId = (req) => {
  const rawViewerId = req.user?.id ?? req.user?.userId;
  const parsed = parseInt(rawViewerId, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

const isAdminViewer = (req) => req.user?.role === 'admin';

const buildPostVisibilityClause = (viewerIdParamName = '$3') => {
  return `
       AND p.is_hidden = FALSE
       AND (${viewerIdParamName}::int IS NULL OR NOT EXISTS (
         SELECT 1
         FROM user_blocks ub
         WHERE (ub.blocker_id = p.user_id AND ub.blocked_user_id = ${viewerIdParamName}::int)
            OR (ub.blocker_id = ${viewerIdParamName}::int AND ub.blocked_user_id = p.user_id)
       ))`;
};

const removeAttachmentFile = (storagePath) => {
  if (!storagePath) return;
  const filePath = path.join(UPLOADS_DIR, storagePath);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Failed to remove attachment file:', err);
    }
  });
};

// Create a new post or comment
exports.createPost = async (req, res) => {
  try {
    const { content, image_url, image_attachment_id, parent_id } = req.body;

    // Input validation
    if (!content || content.trim() === '') {
      return res.status(400).json({ message: 'Content is required' });
    }

    // Get user ID from authenticated user
    const userId = req.user.id;
    const viewerId = isAdminViewer(req) ? null : getViewerId(req);

    // Default values for a regular post
    let parentId = null;
    let depth = 0;
    let isComment = false;
    let postId = null;

    // If parent_id exists, this is a comment
    if (parent_id) {
      // Verify parent exists and get its depth
      const parentResult = await db.query(
        `SELECT * FROM posts p
         WHERE p.id = $1
         ${buildPostVisibilityClause('$2')}`,
        [parent_id, viewerId]
      );

      if (parentResult.rows.length === 0) {
        return res.status(404).json({ message: 'Parent post not found' });
      }

      const parentPost = parentResult.rows[0];
      parentId = parent_id;
      depth = parentPost.depth + 1;
      isComment = true;
      postId = parentPost.id;
    }

    console.log('Creating post/comment with:', { userId, content, image_url, image_attachment_id, parentId, depth, isComment });

    if (image_attachment_id) {
      const attachCheck = await db.query(
        `SELECT id FROM attachments
         WHERE id = $1 AND owner_id = $2 AND scope = 'post' AND post_id IS NULL`,
        [image_attachment_id, userId]
      );
      if (attachCheck.rows.length === 0) {
        return res.status(400).json({ message: 'Invalid image attachment' });
      }
    }

    // Insert the post or comment
    const result = await db.query(
      'INSERT INTO posts (user_id, content, image_url, image_attachment_id, parent_id, depth, is_comment, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING *',
      [userId, content, image_url || null, image_attachment_id || null, parentId, depth, isComment]
    );

    const newPost = result.rows[0];

    if (image_attachment_id) {
      await db.query(
        `UPDATE attachments
         SET post_id = $1
         WHERE id = $2 AND owner_id = $3 AND scope = 'post' AND post_id IS NULL`,
        [newPost.id, image_attachment_id, userId]
      );
    }

    // Fetch the username to include in the response
    const userResult = await db.query('SELECT username FROM users WHERE id = $1', [newPost.user_id]);
    if (userResult.rows.length > 0) {
      newPost.username = userResult.rows[0].username;
    } else {
      // Handle case where user might not be found (optional, but good practice)
      newPost.username = 'Unknown User';
    }

    const contentType = isComment ? 'comment' : 'post';

    // Trigger AI analysis asynchronously
    pangramService.analyzeContent({
      text: content,
      contentType,
      contentId: newPost.id,
      userId
    }).catch(err => {
      console.error('[Pangram] Analysis failed:', err.message || err);
    });

    // If this is a comment, increment the parent's comment_count and create notifications
    if (parentId) {
      await db.query(
        'UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1',
        [parentId]
      );

      // Create notification for the parent author
      try {
        const parentPost = await db.query('SELECT user_id, is_comment FROM posts WHERE id = $1', [parentId]);
        if (parentPost.rows.length > 0) {
          const parentAuthorId = parentPost.rows[0].user_id;
          const isReplyToComment = parentPost.rows[0].is_comment;

          if (isReplyToComment) {
            // This is a reply to a comment
            await notificationService.createReplyNotification(userId, parentId, parentAuthorId, newPost.id);
          } else {
            // This is a comment on a post
            await notificationService.createCommentNotification(userId, parentId, parentAuthorId, newPost.id);
          }
        }
      } catch (notificationError) {
        console.error('Error creating comment/reply notification:', notificationError);
        // Don't fail the comment creation if notification fails
      }

      // Handle via socket.io for real-time updates
      if (req.io) {
        req.io.to(`post:${parentId}`).emit('new_comment', newPost);
      }
    } else if (req.io) {
      // Emit new post event for timeline updates
      req.io.emit('new_post', newPost);
    }

    // ActivityPub federation is best-effort; never block local post creation.
    if (!isComment) {
      const baseUrl = getRequestBaseUrl(req);
      activitypubOutbound.enqueueCreateForLocalPost({
        baseUrl,
        post: newPost,
        username: newPost.username
      }).catch((err) => {
        console.error('[ActivityPub] Failed to enqueue outbound Create:', err?.message || err);
      });

      atprotoOutbound.enqueueCreateForLocalPost({
        post: newPost
      }).catch((err) => {
        console.error('[ATProto] Failed to enqueue outbound post:', err?.message || err);
      });
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
  console.log("--- ENTERING getPosts function ---"); // Add entry log
  // Public feed endpoint: when unauthenticated, keep liked_by_user false.
  const userId = req.user?.id || null;
  const viewerId = isAdminViewer(req) ? null : userId;
  try {
    console.log("getPosts called with userId:", userId);

    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 50);
    const cursorRaw = req.query.cursor;
    let cursor = null;
    if (cursorRaw) {
      try {
        const decoded = JSON.parse(Buffer.from(String(cursorRaw), 'base64url').toString('utf8'));
        const createdAt = new Date(decoded.createdAt);
        const id = Number(decoded.id);
        if (!Number.isFinite(createdAt.getTime()) || !Number.isInteger(id)) throw new Error('Invalid cursor');
        cursor = { createdAt, id };
      } catch {
        return res.status(400).json({ message: 'Invalid cursor' });
      }
    }

    const result = await db.query(
      `SELECT p.*, u.username,
              CASE WHEN EXISTS (SELECT 1 FROM likes 
                                WHERE post_id = p.id AND user_id = $1) 
                   THEN true 
                   ELSE false 
              END AS liked_by_user,
              COALESCE(ur.rep_points, 1.0) as user_rep_points,
              -- Calculate visibility multiplier: higher reputation = more visibility
              -- Use GREATEST to ensure we never take LN of a negative number
              (1 + 0.15 * LN(GREATEST(0.1, 1 + COALESCE(ur.rep_points, 1.0)))) as visibility_multiplier,
              ai.ai_probability,
              ai.detected_model as ai_detected_model,
              ai.is_flagged as ai_is_flagged
       FROM posts p
       JOIN users u ON p.user_id = u.id
       LEFT JOIN user_reputation ur ON u.id = ur.user_id
       LEFT JOIN LATERAL (
         SELECT ai_probability, detected_model, is_flagged
         FROM content_ai_analysis
         WHERE content_type = 'post' AND content_id = p.id
         ORDER BY analyzed_at DESC
         LIMIT 1
       ) ai ON true
       WHERE p.parent_id IS NULL
         AND p.is_comment = FALSE
         ${buildPostVisibilityClause('$1')}
         ${cursor ? 'AND (p.created_at, p.id) < ($3, $4)' : ''}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $2`,
      cursor ? [viewerId, limit + 1, cursor.createdAt, cursor.id] : [viewerId, limit + 1]
    );

    // Log the raw result which should now include reputation data
    console.log("Raw query result:", result.rows.map(post => ({
      id: post.id,
      user_id: post.user_id,
      username: post.username,
      user_rep_points: post.user_rep_points,
      visibility_multiplier: post.visibility_multiplier,
      liked_by_user: post.liked_by_user
    })));

    // Cursor pagination response (always, for performance).
    const rows = result.rows || [];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: new Date(last.created_at).toISOString(), id: last.id })).toString('base64url')
      : null;

    res.status(200).json({ items, hasMore, nextCursor });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching posts' });
  }
};

// Retrieve a single post by ID
exports.getPostById = async (req, res) => {
  const postId = req.params.id;
  const viewerId = isAdminViewer(req) ? null : getViewerId(req);
  try {
    const result = await db.query(
      `SELECT p.*,
              ai.ai_probability,
              ai.detected_model as ai_detected_model,
              ai.is_flagged as ai_is_flagged
       FROM posts p
       LEFT JOIN LATERAL (
         SELECT ai_probability, detected_model, is_flagged
         FROM content_ai_analysis
         WHERE content_type = CASE WHEN p.is_comment THEN 'comment' ELSE 'post' END
           AND content_id = p.id
         ORDER BY analyzed_at DESC
         LIMIT 1
        ) ai ON true
       WHERE p.id = $1
         ${buildPostVisibilityClause('$2')}`,
      [postId, viewerId]
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
  const { content, image_url, image_attachment_id } = req.body;
  const userId = req.user.id;
  const pool = db.getPool();
  const client = await pool.connect();

  try {
    // Input validation
    if (!content || content.trim() === '') {
      client.release();
      return res.status(400).json({ message: 'Content is required' });
    }

    await client.query('BEGIN');

    // First, check if the post exists and get its owner
    const postCheck = await client.query(
      'SELECT user_id, is_comment, image_attachment_id, image_url FROM posts WHERE id = $1 FOR UPDATE',
      [postId]
    );

    if (postCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if the current user owns the post
    const postOwnerId = postCheck.rows[0].user_id;
    const isComment = postCheck.rows[0].is_comment;
    if (postOwnerId !== userId) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(403).json({ message: 'You can only edit your own posts' });
    }

    const hasImageAttachmentId = Object.prototype.hasOwnProperty.call(req.body, 'image_attachment_id');
    const hasImageUrl = Object.prototype.hasOwnProperty.call(req.body, 'image_url');
    const currentAttachmentId = postCheck.rows[0].image_attachment_id;
    const currentImageUrl = postCheck.rows[0].image_url;
    const nextImageAttachmentId = hasImageAttachmentId
      ? (image_attachment_id || null)
      : currentAttachmentId;
    const nextImageUrl = hasImageUrl
      ? (image_url || null)
      : currentImageUrl;
    const isNewAttachment = hasImageAttachmentId && image_attachment_id && image_attachment_id !== currentAttachmentId;

    if (isNewAttachment) {
      const attachmentCheck = await client.query(
        `SELECT id FROM attachments
         WHERE id = $1 AND owner_id = $2 AND scope = 'post' AND post_id IS NULL`,
        [image_attachment_id, userId]
      );
      if (attachmentCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ message: 'Invalid attachment id' });
      }
    }

    const result = await client.query(
      'UPDATE posts SET content = $1, image_url = $2, image_attachment_id = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
      [content, nextImageUrl, nextImageAttachmentId, postId]
    );

    if (isNewAttachment) {
      await client.query(
        `UPDATE attachments
         SET post_id = $1
         WHERE id = $2 AND owner_id = $3 AND scope = 'post' AND post_id IS NULL`,
        [postId, image_attachment_id, userId]
      );
    }

    let removedAttachmentPath = null;
    if (hasImageAttachmentId && currentAttachmentId && currentAttachmentId !== nextImageAttachmentId) {
      const deleteResult = await client.query(
        `DELETE FROM attachments
         WHERE id = $1 AND owner_id = $2 AND scope = 'post' AND post_id = $3
         RETURNING storage_path`,
        [currentAttachmentId, userId, postId]
      );
      removedAttachmentPath = deleteResult.rows[0]?.storage_path || null;
    }

    await client.query('COMMIT');
    client.release();

    if (removedAttachmentPath) {
      removeAttachmentFile(removedAttachmentPath);
    }

    // Fetch the username to include in the response
    const userResult = await db.query('SELECT username FROM users WHERE id = $1', [result.rows[0].user_id]);
    if (userResult.rows.length > 0) {
      result.rows[0].username = userResult.rows[0].username;
    }

    // Emit real-time update if socket.io is available
    if (req.io) {
      req.io.emit('post_updated', result.rows[0]);
    }

    res.status(200).json(result.rows[0]);

    const updatedContentType = isComment ? 'comment' : 'post';
    pangramService.analyzeContent({
      text: content,
      contentType: updatedContentType,
      contentId: postId,
      userId
    }).catch(err => {
      console.error('[Pangram] Analysis failed:', err.message || err);
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    client.release();
    console.error('Error updating post:', err);
    res.status(500).json({ message: 'Error updating the post' });
  }
};

// Delete a post
exports.deletePost = async (req, res) => {
  const postId = req.params.id;
  const pool = db.getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const attachmentsResult = await client.query(
      `SELECT storage_path FROM attachments WHERE post_id = $1 AND scope = 'post'`,
      [postId]
    );

    const result = await client.query(
      'DELETE FROM posts WHERE id = $1 RETURNING *',
      [postId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).send('Post not found');
    }

    await client.query(
      `DELETE FROM attachments WHERE post_id = $1 AND scope = 'post'`,
      [postId]
    );

    await client.query('COMMIT');
    client.release();

    for (const row of attachmentsResult.rows) {
      removeAttachmentFile(row.storage_path);
    }

    res.status(200).json({ message: 'Post deleted successfully' });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    client.release();
    console.error(err);
    res.status(500).send('Error deleting the post');
  }
};

// Get personalized feed of posts from followed users
exports.getFeed = async (req, res) => {
  console.log("--- ENTERING getFeed function ---"); // Add entry log
  const userId = req.user.id; // Using standardized user object
  const viewerId = isAdminViewer(req) ? null : userId;

  try {
    console.log("getFeed called with userId:", userId);

    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 50);
    const cursorRaw = req.query.cursor;
    let cursor = null;
    if (cursorRaw) {
      try {
        const decoded = JSON.parse(Buffer.from(String(cursorRaw), 'base64url').toString('utf8'));
        const createdAt = new Date(decoded.createdAt);
        const id = Number(decoded.id);
        if (!Number.isFinite(createdAt.getTime()) || !Number.isInteger(id)) throw new Error('Invalid cursor');
        cursor = { createdAt, id };
      } catch {
        return res.status(400).json({ message: 'Invalid cursor' });
      }
    }

    const result = await db.query(
      `SELECT p.*, u.username,
              CASE WHEN EXISTS (SELECT 1 FROM likes 
                                WHERE post_id = p.id AND user_id = $1) 
                   THEN true 
                   ELSE false 
              END AS liked_by_user,
              COALESCE(ur.rep_points, 1.0) as user_rep_points,
              -- Calculate visibility multiplier: higher reputation = more visibility
              -- Use GREATEST to ensure we never take LN of a negative number
              (1 + 0.15 * LN(GREATEST(0.1, 1 + COALESCE(ur.rep_points, 1.0)))) as visibility_multiplier,
              ai.ai_probability,
              ai.detected_model as ai_detected_model,
              ai.is_flagged as ai_is_flagged
       FROM posts p
       JOIN users u ON p.user_id = u.id
       LEFT JOIN user_reputation ur ON u.id = ur.user_id
       LEFT JOIN LATERAL (
         SELECT ai_probability, detected_model, is_flagged
         FROM content_ai_analysis
         WHERE content_type = 'post' AND content_id = p.id
         ORDER BY analyzed_at DESC
         LIMIT 1
       ) ai ON true
       WHERE (p.user_id IN (
         SELECT following_id 
         FROM follows 
         WHERE follower_id = $1
       )
       OR p.user_id = $1)
       AND p.parent_id IS NULL
       AND p.is_comment = FALSE
       ${buildPostVisibilityClause('$1')}
       ${cursor ? 'AND (p.created_at, p.id) < ($3, $4)' : ''}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $2`,
      cursor ? [viewerId, limit + 1, cursor.createdAt, cursor.id] : [viewerId, limit + 1]
    );

    // Log the raw result which should include reputation data
    console.log("Raw feed query result:", result.rows.map(post => ({
      id: post.id,
      username: post.username,
      user_rep_points: post.user_rep_points,
      visibility_multiplier: post.visibility_multiplier,
      liked_by_user: post.liked_by_user
    })));

    const rows = result.rows || [];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: new Date(last.created_at).toISOString(), id: last.id })).toString('base64url')
      : null;

    res.status(200).json({ items, hasMore, nextCursor });
  } catch (err) {
    console.error("Error getting feed:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get comments for a post (direct replies only)
exports.getComments = async (req, res) => {
  const postId = req.params.id;
  const viewerId = isAdminViewer(req) ? null : getViewerId(req);

  console.log(`--- GETTING COMMENTS for post ID: ${postId} ---`);

  try {
    // Verify post exists
    console.log(`Checking if post ${postId} exists...`);
    const postCheck = await db.query(
      `SELECT * FROM posts p
       WHERE p.id = $1
       ${buildPostVisibilityClause('$2')}`,
      [postId, viewerId]
    );

    console.log(`Post check result: Found ${postCheck.rows.length} post(s)`);

    if (postCheck.rows.length === 0) {
      console.log(`Post ${postId} not found, returning 404`);
      return res.status(404).json({ message: 'Post not found' });
    }

    // Get direct comments for this post
    console.log(`Fetching comments for post ${postId}...`);

    try {
      const result = await db.query(
        `SELECT p.*, u.username,
                ai.ai_probability,
                ai.detected_model as ai_detected_model,
                ai.is_flagged as ai_is_flagged
         FROM posts p
         JOIN users u ON p.user_id = u.id
         LEFT JOIN LATERAL (
           SELECT ai_probability, detected_model, is_flagged
           FROM content_ai_analysis
           WHERE content_type = 'comment' AND content_id = p.id
           ORDER BY analyzed_at DESC
           LIMIT 1
         ) ai ON true
         WHERE p.parent_id = $1
         ${buildPostVisibilityClause('$2')}
         ORDER BY p.created_at ASC`,
        [postId, viewerId]
      );

      console.log(`Found ${result.rows.length} comments for post ${postId}`);
      res.status(200).json(result.rows);
    } catch (queryError) {
      console.error('SQL error fetching comments:', queryError);
      return res.status(500).json({ message: 'Database error fetching comments', error: queryError.message });
    }
  } catch (error) {
    console.error('Error in getComments controller:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ message: 'Error fetching comments' });
  }
};

// Get a full comment tree (with nesting) for a post
exports.getCommentTree = async (req, res) => {
  const postId = req.params.id;
  const maxDepth = req.query.maxDepth ? parseInt(req.query.maxDepth, 10) : 10; // Default max depth to 10
  const viewerId = isAdminViewer(req) ? null : getViewerId(req);

  try {
    // Verify post exists
    const postCheck = await db.query(
      `SELECT * FROM posts p
       WHERE p.id = $1
       ${buildPostVisibilityClause('$2')}`,
      [postId, viewerId]
    );

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
           1 AS level
         FROM posts p
         JOIN users u ON p.user_id = u.id
         WHERE p.parent_id = $1
         ${buildPostVisibilityClause('$3')}
         
         UNION ALL
         
         -- Recursive case: replies to comments
       SELECT 
           p.*, 
           u.username,
           ct.level + 1
         FROM posts p
         JOIN users u ON p.user_id = u.id
         JOIN comment_tree ct ON p.parent_id = ct.id
         WHERE ct.level < $2
         ${buildPostVisibilityClause('$3')}
       )
       SELECT ct.*,
              ai.ai_probability,
              ai.detected_model as ai_detected_model,
              ai.is_flagged as ai_is_flagged
       FROM comment_tree ct
       LEFT JOIN LATERAL (
         SELECT ai_probability, detected_model, is_flagged
         FROM content_ai_analysis
         WHERE content_type = 'comment' AND content_id = ct.id
         ORDER BY analyzed_at DESC
         LIMIT 1
       ) ai ON true
       ORDER BY level ASC, created_at ASC`,
      [postId, maxDepth, viewerId]
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
