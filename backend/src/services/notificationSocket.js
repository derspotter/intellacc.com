// backend/src/services/notificationSocket.js
const notificationService = require('./notificationService');

/**
 * Initialize notification-related socket handlers
 * @param {Object} io - Socket.io instance
 */
function initializeNotificationSocket(io) {
  // Map to track which socket belongs to which user
  const userSocketMap = new Map();

  io.on('connection', (socket) => {
    console.log('[NotificationSocket] New socket connection:', socket.id);

    // Handle user authentication for notifications
    socket.on('authenticate', (userId) => {
      if (!userId) {
        console.log('[NotificationSocket] Authentication failed - no userId provided');
        return;
      }

      // Join user-specific room for targeted notifications
      const userRoom = `user:${userId}`;
      socket.join(userRoom);
      
      // Store the mapping
      userSocketMap.set(socket.id, userId);
      
      console.log(`[NotificationSocket] User ${userId} joined room ${userRoom}`);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      const userId = userSocketMap.get(socket.id);
      if (userId) {
        console.log(`[NotificationSocket] User ${userId} disconnected`);
        userSocketMap.delete(socket.id);
      }
    });
  });

  return io;
}

/**
 * Emit a notification to a specific user
 * @param {Object} io - Socket.io instance
 * @param {number} userId - User ID to send notification to
 * @param {Object} notification - Notification object
 */
function emitNotificationToUser(io, userId, notification) {
  const userRoom = `user:${userId}`;
  
  // Emit the notification to the user's room
  io.to(userRoom).emit('notification', {
    type: 'new',
    notification
  });
  
  console.log(`[NotificationSocket] Sent notification to user ${userId}:`, notification.type);
}

/**
 * Create and emit a notification
 * @param {Object} io - Socket.io instance
 * @param {Object} notificationData - Data for creating the notification
 */
async function createAndEmitNotification(io, notificationData) {
  try {
    // Create the notification in the database
    const notification = await notificationService.createNotification(notificationData);
    
    if (notification) {
      // Fetch the full notification with actor details
      const fullNotification = await notificationService.getUserNotifications(
        notificationData.userId, 
        { limit: 1, offset: 0 }
      );
      
      if (fullNotification.length > 0) {
        // Emit to the recipient
        emitNotificationToUser(io, notificationData.userId, fullNotification[0]);
      }
    }
    
    return notification;
  } catch (error) {
    console.error('[NotificationSocket] Error creating and emitting notification:', error);
    throw error;
  }
}

/**
 * Notify user of unread count change
 * @param {Object} io - Socket.io instance
 * @param {number} userId - User ID
 */
async function updateUnreadCount(io, userId) {
  try {
    const count = await notificationService.getUnreadNotificationCount(userId);
    
    io.to(`user:${userId}`).emit('notification', {
      type: 'unreadCountUpdate',
      count
    });
    
    console.log(`[NotificationSocket] Updated unread count for user ${userId}: ${count}`);
  } catch (error) {
    console.error('[NotificationSocket] Error updating unread count:', error);
  }
}

module.exports = {
  initializeNotificationSocket,
  emitNotificationToUser,
  createAndEmitNotification,
  updateUnreadCount
};