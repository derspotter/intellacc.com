// backend/src/services/notificationService.js
const db = require('../db');

// Socket.io instance will be injected
let io = null;

/**
 * Set the Socket.io instance for real-time notifications
 * @param {Object} socketIo - Socket.io instance
 */
function setSocketIo(socketIo) {
  io = socketIo;
}

/**
 * Create a new notification
 * @param {Object} notificationData - The notification data
 * @param {number} notificationData.userId - ID of the user receiving the notification
 * @param {string} notificationData.type - Type of notification (like, comment, follow, etc.)
 * @param {number} notificationData.actorId - ID of the user who performed the action
 * @param {number} notificationData.targetId - ID of the target (post, comment, user)
 * @param {string} notificationData.targetType - Type of target (post, comment, user)
 * @param {string} notificationData.content - Optional content/message
 * @returns {Promise<Object>} The created notification
 */
async function createNotification({ userId, type, actorId, targetId, targetType, content = null }) {
  try {
    // Prevent self-notifications
    if (userId === actorId) {
      return null;
    }

    // Check if a similar notification already exists (to prevent spam)
    const existingNotification = await db.query(
      `SELECT id FROM notifications 
       WHERE user_id = $1 AND type = $2 AND actor_id = $3 
       AND target_id = $4 AND target_type = $5 
       AND created_at > NOW() - INTERVAL '1 hour'`,
      [userId, type, actorId, targetId, targetType]
    );

    if (existingNotification.rows.length > 0) {
      return null; // Don't create duplicate notifications within an hour
    }

    // Create the notification
    const result = await db.query(
      `INSERT INTO notifications (user_id, type, actor_id, target_id, target_type, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, type, actorId, targetId, targetType, content]
    );

    const notification = result.rows[0];

    // Emit real-time notification if socket.io is available
    if (io && notification) {
      try {
        // Get the full notification with actor details
        const fullNotification = await getUserNotifications(userId, { limit: 1, offset: 0 });
        
        if (fullNotification.length > 0) {
          // Emit to the user's room
          io.to(`user:${userId}`).emit('notification', {
            type: 'new',
            notification: fullNotification[0]
          });

          // Also emit unread count update
          const unreadCount = await getUnreadNotificationCount(userId);
          io.to(`user:${userId}`).emit('notification', {
            type: 'unreadCountUpdate',
            count: unreadCount
          });
        }
      } catch (socketError) {
        console.error('Error emitting real-time notification:', socketError);
        // Don't fail the notification creation if socket emission fails
      }
    }

    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
}

/**
 * Get notifications for a user
 * @param {number} userId - ID of the user
 * @param {Object} options - Query options
 * @param {number} options.limit - Number of notifications to return (default: 20)
 * @param {number} options.offset - Offset for pagination (default: 0)
 * @param {boolean} options.unreadOnly - Whether to return only unread notifications
 * @returns {Promise<Array>} Array of notifications with actor information
 */
async function getUserNotifications(userId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
  try {
    console.log(`Fetching notifications for user ${userId}, limit: ${limit}, offset: ${offset}, unreadOnly: ${unreadOnly}`);
    
    let query = `
      SELECT n.*, 
             u.username as actor_username,
             CASE 
               WHEN n.target_type = 'post' THEN p.content
               WHEN n.target_type = 'comment' THEN c.content
               ELSE NULL
             END as target_content
      FROM notifications n
      JOIN users u ON n.actor_id = u.id
      LEFT JOIN posts p ON n.target_type = 'post' AND n.target_id = p.id
      LEFT JOIN posts c ON n.target_type = 'comment' AND n.target_id = c.id
      WHERE n.user_id = $1
    `;

    const params = [userId];

    if (unreadOnly) {
      query += ' AND n.read = false';
    }

    query += ' ORDER BY n.created_at DESC LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const result = await db.query(query, params);
    console.log(`Found ${result.rows.length} notifications for user ${userId}`);
    return result.rows;
  } catch (error) {
    console.error('Error fetching notifications:', error);
    throw error;
  }
}

/**
 * Mark a notification as read
 * @param {number} notificationId - ID of the notification
 * @param {number} userId - ID of the user (for security)
 * @returns {Promise<Object>} The updated notification
 */
async function markNotificationAsRead(notificationId, userId) {
  try {
    const result = await db.query(
      'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING *',
      [notificationId, userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Notification not found or unauthorized');
    }

    return result.rows[0];
  } catch (error) {
    console.error('Error marking notification as read:', error);
    throw error;
  }
}

/**
 * Mark all notifications as read for a user
 * @param {number} userId - ID of the user
 * @returns {Promise<number>} Number of notifications marked as read
 */
async function markAllNotificationsAsRead(userId) {
  try {
    const result = await db.query(
      'UPDATE notifications SET read = true WHERE user_id = $1 AND read = false',
      [userId]
    );

    return result.rowCount;
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    throw error;
  }
}

/**
 * Get unread notification count for a user
 * @param {number} userId - ID of the user
 * @returns {Promise<number>} Number of unread notifications
 */
async function getUnreadNotificationCount(userId) {
  try {
    const result = await db.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND read = false',
      [userId]
    );

    return parseInt(result.rows[0].count, 10);
  } catch (error) {
    console.error('Error getting unread notification count:', error);
    throw error;
  }
}

/**
 * Delete a notification
 * @param {number} notificationId - ID of the notification
 * @param {number} userId - ID of the user (for security)
 * @returns {Promise<boolean>} True if deleted successfully
 */
async function deleteNotification(notificationId, userId) {
  try {
    const result = await db.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [notificationId, userId]
    );

    return result.rowCount > 0;
  } catch (error) {
    console.error('Error deleting notification:', error);
    throw error;
  }
}

/**
 * Create a notification for a new like
 * @param {number} likerUserId - ID of the user who liked
 * @param {number} postId - ID of the post that was liked
 * @param {number} postAuthorId - ID of the post author
 * @returns {Promise<Object>} The created notification
 */
async function createLikeNotification(likerUserId, postId, postAuthorId) {
  const likerResult = await db.query('SELECT username FROM users WHERE id = $1', [likerUserId]);
  const likerUsername = likerResult.rows[0]?.username || 'Someone';

  return createNotification({
    userId: postAuthorId,
    type: 'like',
    actorId: likerUserId,
    targetId: postId,
    targetType: 'post',
    content: `${likerUsername} liked your post`
  });
}

/**
 * Create a notification for a new comment
 * @param {number} commenterUserId - ID of the user who commented
 * @param {number} postId - ID of the post that was commented on
 * @param {number} postAuthorId - ID of the post author
 * @param {number} commentId - ID of the new comment
 * @returns {Promise<Object>} The created notification
 */
async function createCommentNotification(commenterUserId, postId, postAuthorId, commentId) {
  const commenterResult = await db.query('SELECT username FROM users WHERE id = $1', [commenterUserId]);
  const commenterUsername = commenterResult.rows[0]?.username || 'Someone';

  return createNotification({
    userId: postAuthorId,
    type: 'comment',
    actorId: commenterUserId,
    targetId: commentId,
    targetType: 'comment',
    content: `${commenterUsername} commented on your post`
  });
}

/**
 * Create a notification for a new follow
 * @param {number} followerUserId - ID of the user who followed
 * @param {number} followedUserId - ID of the user who was followed
 * @returns {Promise<Object>} The created notification
 */
async function createFollowNotification(followerUserId, followedUserId) {
  const followerResult = await db.query('SELECT username FROM users WHERE id = $1', [followerUserId]);
  const followerUsername = followerResult.rows[0]?.username || 'Someone';

  return createNotification({
    userId: followedUserId,
    type: 'follow',
    actorId: followerUserId,
    targetId: followedUserId,
    targetType: 'user',
    content: `${followerUsername} started following you`
  });
}

/**
 * Create a notification for a reply to a comment
 * @param {number} replierUserId - ID of the user who replied
 * @param {number} parentCommentId - ID of the parent comment
 * @param {number} parentCommentAuthorId - ID of the parent comment author
 * @param {number} replyId - ID of the reply comment
 * @returns {Promise<Object>} The created notification
 */
async function createReplyNotification(replierUserId, parentCommentId, parentCommentAuthorId, replyId) {
  const replierResult = await db.query('SELECT username FROM users WHERE id = $1', [replierUserId]);
  const replierUsername = replierResult.rows[0]?.username || 'Someone';

  return createNotification({
    userId: parentCommentAuthorId,
    type: 'reply',
    actorId: replierUserId,
    targetId: replyId,
    targetType: 'comment',
    content: `${replierUsername} replied to your comment`
  });
}

module.exports = {
  setSocketIo,
  createNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  getUnreadNotificationCount,
  deleteNotification,
  createLikeNotification,
  createCommentNotification,
  createFollowNotification,
  createReplyNotification
};