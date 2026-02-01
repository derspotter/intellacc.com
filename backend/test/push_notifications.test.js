const request = require('supertest');
const db = require('../src/db');
const { getTestServer, releaseTestServer } = require('./testServer');

jest.setTimeout(30000);

describe('Push Notifications API', () => {
  let api;
  let authToken;
  let testUserId;

  beforeAll(async () => {
    const { baseUrl } = await getTestServer();
    api = request(baseUrl);

    // Create a test user and get auth token
    const uniqueEmail = `pushtest_${Date.now()}@example.com`;
    const uniqueUsername = `pushtest_${Date.now()}`;

    const registerRes = await api
      .post('/api/users/register')
      .send({
        username: uniqueUsername,
        email: uniqueEmail,
        password: 'testpass123'
      });

    if (registerRes.statusCode === 201) {
      testUserId = registerRes.body.user?.id;
    }

    // Login to get token
    const loginRes = await api
      .post('/api/login')
      .send({ email: uniqueEmail, password: 'testpass123' });

    if (loginRes.statusCode === 200) {
      authToken = loginRes.body.token;
    }
  });

  afterAll(async () => {
    // Cleanup: remove test user's push subscriptions
    if (testUserId) {
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [testUserId]);
      await db.query('DELETE FROM notification_preferences WHERE user_id = $1', [testUserId]);
    }
    await releaseTestServer();
  });

  describe('GET /api/push/vapid-public-key', () => {
    test('should return VAPID public key (no auth required)', async () => {
      const res = await api.get('/api/push/vapid-public-key');

      // May return 503 if VAPID not configured, or 200 with key
      expect([200, 503]).toContain(res.statusCode);

      if (res.statusCode === 200) {
        expect(res.body.publicKey).toBeDefined();
        expect(typeof res.body.publicKey).toBe('string');
      }
    });
  });

  describe('POST /api/push/subscribe', () => {
    test('should require authentication', async () => {
      const res = await api
        .post('/api/push/subscribe')
        .send({
          endpoint: 'https://example.com/push/test',
          keys: { p256dh: 'testkey', auth: 'testauth' }
        });

      expect(res.statusCode).toBe(401);
    });

    test('should validate subscription data', async () => {
      if (!authToken) return;

      const res = await api
        .post('/api/push/subscribe')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ endpoint: 'https://test.com' }); // Missing keys

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toContain('keys');
    });

    test('should save valid subscription', async () => {
      if (!authToken) return;

      const subscription = {
        endpoint: `https://example.com/push/test_${Date.now()}`,
        keys: {
          p256dh: 'test-p256dh-key-placeholder',
          auth: 'test-auth-placeholder'
        }
      };

      const res = await api
        .post('/api/push/subscribe')
        .set('Authorization', `Bearer ${authToken}`)
        .send(subscription);

      expect(res.statusCode).toBe(201);
      expect(res.body.message).toBe('Subscription saved');
    });
  });

  describe('DELETE /api/push/subscribe', () => {
    test('should require authentication', async () => {
      const res = await api
        .delete('/api/push/subscribe')
        .send({ endpoint: 'https://test.com' });

      expect(res.statusCode).toBe(401);
    });

    test('should unsubscribe with valid endpoint', async () => {
      if (!authToken) return;

      // First subscribe
      const endpoint = `https://example.com/push/unsub_${Date.now()}`;
      await api
        .post('/api/push/subscribe')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          endpoint,
          keys: { p256dh: 'testkey', auth: 'testauth' }
        });

      // Then unsubscribe
      const res = await api
        .delete('/api/push/subscribe')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ endpoint });

      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('Unsubscribed successfully');
    });
  });

  describe('GET /api/push/preferences', () => {
    test('should require authentication', async () => {
      const res = await api.get('/api/push/preferences');
      expect(res.statusCode).toBe(401);
    });

    test('should return default preferences', async () => {
      if (!authToken) return;

      const res = await api
        .get('/api/push/preferences')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.preferences).toBeDefined();
      expect(res.body.preferences.push_replies).toBe(true);
      expect(res.body.preferences.push_follows).toBe(true);
      expect(res.body.preferences.push_messages).toBe(true);
    });
  });

  describe('PUT /api/push/preferences', () => {
    test('should require authentication', async () => {
      const res = await api
        .put('/api/push/preferences')
        .send({ push_replies: false });

      expect(res.statusCode).toBe(401);
    });

    test('should update preferences', async () => {
      if (!authToken) return;

      const res = await api
        .put('/api/push/preferences')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          push_replies: false,
          push_follows: true,
          push_messages: false
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.preferences.push_replies).toBe(false);
      expect(res.body.preferences.push_follows).toBe(true);
      expect(res.body.preferences.push_messages).toBe(false);
    });
  });
});
