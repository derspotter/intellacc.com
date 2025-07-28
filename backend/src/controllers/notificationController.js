// backend/src/controllers/notificationController.js
const notificationService = require('../services/notificationService');

/**
 * Get notifications for the authenticated user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20, offset = 0, unreadOnly = false } = req.query;

    const notifications = await notificationService.getUserNotifications(userId, {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      unreadOnly: unreadOnly === 'true'
    });

    res.status(200).json({
      notifications,
      count: notifications.length
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Get unread notification count for the authenticated user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.id;
    const count = await notificationService.getUnreadNotificationCount(userId);

    res.status(200).json({ count });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Mark a notification as read
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.markAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const userId = req.user.id;

    const notification = await notificationService.markNotificationAsRead(
      parseInt(notificationId, 10),
      userId
    );

    res.status(200).json({
      message: 'Notification marked as read',
      notification
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    
    if (error.message === 'Notification not found or unauthorized') {
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Mark all notifications as read for the authenticated user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const count = await notificationService.markAllNotificationsAsRead(userId);

    res.status(200).json({
      message: 'All notifications marked as read',
      count
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Delete a notification
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const userId = req.user.id;

    const deleted = await notificationService.deleteNotification(
      parseInt(notificationId, 10),
      userId
    );

    if (!deleted) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.status(200).json({ message: 'Notification deleted successfully' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: 'Server error' });
  }
};