// backend/src/controllers/pushController.js
const pushNotificationService = require('../services/pushNotificationService');

/**
 * Get VAPID public key for frontend subscription
 */
exports.getVapidPublicKey = async (req, res) => {
  try {
    const publicKey = pushNotificationService.getVapidPublicKey();

    if (!publicKey) {
      return res.status(503).json({
        message: 'Push notifications not configured'
      });
    }

    res.status(200).json({ publicKey });
  } catch (error) {
    console.error('Error getting VAPID key:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Subscribe to push notifications
 */
exports.subscribe = async (req, res) => {
  try {
    const userId = req.user.id;
    const { endpoint, keys } = req.body;

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({
        message: 'Invalid subscription: missing endpoint or keys'
      });
    }

    const userAgent = req.headers['user-agent'] || null;

    const subscription = await pushNotificationService.saveSubscription(
      userId,
      { endpoint, keys },
      userAgent
    );

    res.status(201).json({
      message: 'Subscription saved',
      subscription: { id: subscription.id }
    });
  } catch (error) {
    console.error('Error saving push subscription:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Unsubscribe from push notifications
 */
exports.unsubscribe = async (req, res) => {
  try {
    const userId = req.user.id;
    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({
        message: 'Missing endpoint'
      });
    }

    const removed = await pushNotificationService.removeSubscription(userId, endpoint);

    if (!removed) {
      return res.status(404).json({
        message: 'Subscription not found'
      });
    }

    res.status(200).json({ message: 'Unsubscribed successfully' });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Get notification preferences
 */
exports.getPreferences = async (req, res) => {
  try {
    const userId = req.user.id;
    const preferences = await pushNotificationService.getPreferences(userId);

    res.status(200).json({ preferences });
  } catch (error) {
    console.error('Error getting notification preferences:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Update notification preferences
 */
exports.updatePreferences = async (req, res) => {
  try {
    const userId = req.user.id;
    const { push_replies, push_follows, push_messages } = req.body;

    const preferences = await pushNotificationService.updatePreferences(userId, {
      push_replies: push_replies !== false,
      push_follows: push_follows !== false,
      push_messages: push_messages !== false
    });

    res.status(200).json({
      message: 'Preferences updated',
      preferences
    });
  } catch (error) {
    console.error('Error updating notification preferences:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
