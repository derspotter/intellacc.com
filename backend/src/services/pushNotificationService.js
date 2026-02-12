// backend/src/services/pushNotificationService.js
const webpush = require('web-push');
const db = require('../db');

// Configure VAPID keys from environment.
// In Jest runs we auto-generate ephemeral keys so integration tests don't depend on external config.
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@intellacc.com';

// Initialize web-push if keys are configured
if ((!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) && process.env.JEST_WORKER_ID) {
  try {
    const generated = webpush.generateVAPIDKeys();
    VAPID_PUBLIC_KEY = generated.publicKey;
    VAPID_PRIVATE_KEY = generated.privateKey;
    console.log('[Push] Generated ephemeral VAPID keys for tests');
  } catch (err) {
    console.warn('[Push] Failed to generate VAPID keys for tests:', err?.message || err);
  }
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[Push] Web Push configured with VAPID keys');
} else {
  console.warn('[Push] VAPID keys not configured - push notifications disabled');
}

/**
 * Get the VAPID public key for frontend subscription
 */
function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

/**
 * Save a push subscription for a user
 */
async function saveSubscription(userId, subscription, userAgent = null) {
  const { endpoint, keys } = subscription;
  const { p256dh, auth } = keys;

  const query = `
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (endpoint) DO UPDATE SET
      user_id = $1,
      p256dh = $3,
      auth = $4,
      user_agent = $5,
      last_used_at = NOW()
    RETURNING *;
  `;

  const { rows } = await db.query(query, [userId, endpoint, p256dh, auth, userAgent]);
  console.log(`[Push] Subscription saved for user ${userId}`);
  return rows[0];
}

/**
 * Remove a push subscription
 */
async function removeSubscription(userId, endpoint) {
  const query = `
    DELETE FROM push_subscriptions
    WHERE user_id = $1 AND endpoint = $2
    RETURNING *;
  `;

  const { rows } = await db.query(query, [userId, endpoint]);
  if (rows.length > 0) {
    console.log(`[Push] Subscription removed for user ${userId}`);
  }
  return rows.length > 0;
}

/**
 * Get all subscriptions for a user (multi-device support)
 */
async function getUserSubscriptions(userId) {
  const query = `
    SELECT * FROM push_subscriptions
    WHERE user_id = $1
    ORDER BY last_used_at DESC;
  `;

  const { rows } = await db.query(query, [userId]);
  return rows;
}

/**
 * Get user notification preferences
 */
async function getPreferences(userId) {
  const query = `
    SELECT * FROM notification_preferences
    WHERE user_id = $1;
  `;

  const { rows } = await db.query(query, [userId]);

  // Return defaults if no preferences set
  if (rows.length === 0) {
    return {
      user_id: userId,
      push_replies: true,
      push_follows: true,
      push_messages: true
    };
  }

  return rows[0];
}

/**
 * Update user notification preferences
 */
async function updatePreferences(userId, preferences) {
  const { push_replies, push_follows, push_messages } = preferences;

  const query = `
    INSERT INTO notification_preferences (user_id, push_replies, push_follows, push_messages, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      push_replies = $2,
      push_follows = $3,
      push_messages = $4,
      updated_at = NOW()
    RETURNING *;
  `;

  const { rows } = await db.query(query, [userId, push_replies, push_follows, push_messages]);
  return rows[0];
}

/**
 * Check if push is enabled for a notification type
 */
async function isPushEnabledForType(userId, type) {
  const prefs = await getPreferences(userId);

  switch (type) {
    case 'reply':
      return prefs.push_replies;
    case 'follow':
      return prefs.push_follows;
    case 'message':
      return prefs.push_messages;
    default:
      return false;
  }
}

/**
 * Send a push notification to all user devices
 */
async function sendPushToUser(userId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log('[Push] Skipping - VAPID keys not configured');
    return { sent: 0, failed: 0 };
  }

  // Check user preferences
  const type = payload.type;
  if (type && !(await isPushEnabledForType(userId, type))) {
    console.log(`[Push] Skipping - user ${userId} has disabled ${type} notifications`);
    return { sent: 0, failed: 0, skipped: true };
  }

  const subscriptions = await getUserSubscriptions(userId);
  if (subscriptions.length === 0) {
    console.log(`[Push] No subscriptions for user ${userId}`);
    return { sent: 0, failed: 0 };
  }

  // Build notification payload
  const notificationPayload = JSON.stringify({
    title: payload.title || 'Intellacc',
    body: payload.body || payload.content || 'You have a new notification',
    url: payload.url || '/',
    type: payload.type,
    notificationId: payload.notificationId
  });

  let sent = 0;
  let failed = 0;

  // Send to all devices
  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth
      }
    };

    try {
      await webpush.sendNotification(pushSubscription, notificationPayload);
      sent++;

      // Update last_used_at
      await db.query(
        'UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1',
        [sub.id]
      );
    } catch (error) {
      failed++;
      console.error(`[Push] Failed to send to subscription ${sub.id}:`, error.message);

      // Remove invalid subscriptions (410 Gone or 404)
      if (error.statusCode === 410 || error.statusCode === 404) {
        console.log(`[Push] Removing expired subscription ${sub.id}`);
        await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      }
    }
  }

  console.log(`[Push] Sent to user ${userId}: ${sent} succeeded, ${failed} failed`);
  return { sent, failed };
}

/**
 * Send push for a reply notification
 */
async function sendReplyPush(userId, actorUsername, targetContent) {
  return sendPushToUser(userId, {
    type: 'reply',
    title: 'New reply',
    body: `${actorUsername} replied to your comment`,
    url: '/#notifications'
  });
}

/**
 * Send push for a follow notification
 */
async function sendFollowPush(userId, followerUsername) {
  return sendPushToUser(userId, {
    type: 'follow',
    title: 'New follower',
    body: `${followerUsername} started following you`,
    url: '/#notifications'
  });
}

/**
 * Send push for a new message (E2EE - no content)
 */
async function sendMessagePush(userId, senderUsername) {
  return sendPushToUser(userId, {
    type: 'message',
    title: 'New message',
    body: `New message from ${senderUsername}`,
    url: '/#messages'
  });
}

module.exports = {
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  getUserSubscriptions,
  getPreferences,
  updatePreferences,
  sendPushToUser,
  sendReplyPush,
  sendFollowPush,
  sendMessagePush
};
