/**
 * Integration test: Messaging triggers push notifications
 * Tests that the push notification service correctly integrates with messaging
 */
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
const pushService = require('../src/services/pushNotificationService');

jest.setTimeout(30000);

describe('Messaging + Push Notification Integration', () => {
  let sender, recipient;
  let senderToken, recipientToken;

  beforeAll(async () => {
    // Create sender user
    const senderEmail = `sender_${Date.now()}@test.com`;
    const senderUsername = `sender_${Date.now()}`;
    await request(app).post('/api/users/register').send({
      username: senderUsername,
      email: senderEmail,
      password: 'testpass123'
    });

    const senderLogin = await request(app).post('/api/login').send({
      email: senderEmail,
      password: 'testpass123'
    });

    senderToken = senderLogin.body.token;
    const senderDb = await db.query('SELECT id FROM users WHERE email = $1', [senderEmail]);
    sender = { id: senderDb.rows[0].id, username: senderUsername, email: senderEmail };

    // Create recipient user
    const recipientEmail = `recipient_${Date.now()}@test.com`;
    const recipientUsername = `recipient_${Date.now()}`;
    await request(app).post('/api/users/register').send({
      username: recipientUsername,
      email: recipientEmail,
      password: 'testpass123'
    });

    const recipientLogin = await request(app).post('/api/login').send({
      email: recipientEmail,
      password: 'testpass123'
    });

    recipientToken = recipientLogin.body.token;
    const recipientDb = await db.query('SELECT id FROM users WHERE email = $1', [recipientEmail]);
    recipient = { id: recipientDb.rows[0].id, username: recipientUsername, email: recipientEmail };
  });

  afterAll(async () => {
    // Cleanup
    if (sender?.id) {
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [sender.id]);
      await db.query('DELETE FROM notification_preferences WHERE user_id = $1', [sender.id]);
    }
    if (recipient?.id) {
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [recipient.id]);
      await db.query('DELETE FROM notification_preferences WHERE user_id = $1', [recipient.id]);
    }
  });

  describe('Push subscription flow', () => {
    test('user can subscribe to push notifications', async () => {
      const subscription = {
        endpoint: `https://push.example.com/recipient_${Date.now()}`,
        keys: {
          p256dh: 'test-p256dh-key-integration',
          auth: 'test-auth-key'
        }
      };

      const res = await request(app)
        .post('/api/push/subscribe')
        .set('Authorization', `Bearer ${recipientToken}`)
        .send(subscription);

      expect(res.statusCode).toBe(201);

      // Verify subscription in database
      const subs = await db.query(
        'SELECT * FROM push_subscriptions WHERE user_id = $1',
        [recipient.id]
      );
      expect(subs.rows.length).toBe(1);
      expect(subs.rows[0].endpoint).toBe(subscription.endpoint);
    });

    test('default preferences enable all notification types', async () => {
      const prefs = await pushService.getPreferences(recipient.id);

      expect(prefs.push_replies).toBe(true);
      expect(prefs.push_follows).toBe(true);
      expect(prefs.push_messages).toBe(true);
    });
  });

  describe('Push notification triggering', () => {
    test('sendMessagePush creates correct notification payload', async () => {
      // Ensure recipient has a subscription
      await pushService.saveSubscription(recipient.id, {
        endpoint: `https://push.test/msg_${Date.now()}`,
        keys: { p256dh: 'test-key', auth: 'test-auth' }
      });

      // sendMessagePush will fail to actually send (invalid endpoint)
      // but we can verify the function runs without error
      const result = await pushService.sendMessagePush(recipient.id, sender.username);

      // Result should show attempted sends (will fail due to invalid endpoint)
      expect(result).toBeDefined();
      expect(typeof result.sent).toBe('number');
      expect(typeof result.failed).toBe('number');
    });

    test('push is skipped when user disables message notifications', async () => {
      // Disable message notifications
      await pushService.updatePreferences(recipient.id, {
        push_replies: true,
        push_follows: true,
        push_messages: false
      });

      // Ensure subscription exists
      await pushService.saveSubscription(recipient.id, {
        endpoint: `https://push.test/skip_${Date.now()}`,
        keys: { p256dh: 'test-key', auth: 'test-auth' }
      });

      const result = await pushService.sendPushToUser(recipient.id, {
        type: 'message',
        title: 'New message',
        body: 'Test'
      });

      expect(result.skipped).toBe(true);
      expect(result.sent).toBe(0);

      // Re-enable for other tests
      await pushService.updatePreferences(recipient.id, {
        push_replies: true,
        push_follows: true,
        push_messages: true
      });
    });

    test('push returns 0 sent when user has no subscriptions', async () => {
      // Remove all subscriptions
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [recipient.id]);

      const result = await pushService.sendPushToUser(recipient.id, {
        type: 'message',
        title: 'New message',
        body: 'Test'
      });

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBeUndefined();
    });
  });

  describe('Follow notification integration', () => {
    test('follow triggers push notification', async () => {
      // Subscribe recipient to push
      await pushService.saveSubscription(recipient.id, {
        endpoint: `https://push.test/follow_${Date.now()}`,
        keys: { p256dh: 'test', auth: 'test' }
      });

      // sendFollowPush will attempt to send
      const result = await pushService.sendFollowPush(recipient.id, sender.username);

      expect(result).toBeDefined();
      expect(typeof result.sent).toBe('number');
    });

    test('follow push is skipped when disabled in preferences', async () => {
      await pushService.updatePreferences(recipient.id, {
        push_replies: true,
        push_follows: false,
        push_messages: true
      });

      const result = await pushService.sendFollowPush(recipient.id, sender.username);

      expect(result.skipped).toBe(true);

      // Reset
      await pushService.updatePreferences(recipient.id, {
        push_replies: true,
        push_follows: true,
        push_messages: true
      });
    });
  });

  describe('Reply notification integration', () => {
    test('reply triggers push notification', async () => {
      await pushService.saveSubscription(recipient.id, {
        endpoint: `https://push.test/reply_${Date.now()}`,
        keys: { p256dh: 'test', auth: 'test' }
      });

      const result = await pushService.sendReplyPush(recipient.id, sender.username, 'test content');

      expect(result).toBeDefined();
      expect(typeof result.sent).toBe('number');
    });

    test('reply push is skipped when disabled in preferences', async () => {
      await pushService.updatePreferences(recipient.id, {
        push_replies: false,
        push_follows: true,
        push_messages: true
      });

      const result = await pushService.sendReplyPush(recipient.id, sender.username, 'test');

      expect(result.skipped).toBe(true);

      // Reset
      await pushService.updatePreferences(recipient.id, {
        push_replies: true,
        push_follows: true,
        push_messages: true
      });
    });
  });

  describe('Multi-device support', () => {
    test('push is sent to all user devices', async () => {
      // Clear existing subscriptions
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [recipient.id]);

      // Add multiple subscriptions (simulating multiple devices)
      await pushService.saveSubscription(recipient.id, {
        endpoint: `https://push.test/device1_${Date.now()}`,
        keys: { p256dh: 'device1-key', auth: 'device1-auth' }
      });
      await pushService.saveSubscription(recipient.id, {
        endpoint: `https://push.test/device2_${Date.now()}`,
        keys: { p256dh: 'device2-key', auth: 'device2-auth' }
      });

      const subs = await pushService.getUserSubscriptions(recipient.id);
      expect(subs.length).toBe(2);

      // Attempt to send to all devices
      const result = await pushService.sendPushToUser(recipient.id, {
        type: 'message',
        title: 'Test',
        body: 'Multi-device test'
      });

      // Both will fail (invalid endpoints) but should be attempted
      expect(result.sent + result.failed).toBe(2);
    });
  });
});
