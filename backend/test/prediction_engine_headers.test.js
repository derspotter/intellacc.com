process.env.PREDICTION_ENGINE_AUTH_TOKEN = 'test-engine-token';

const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
const bcrypt = require('bcryptjs');

jest.setTimeout(10000);

describe('Prediction engine proxy headers', () => {
let originalFetch;
let testUser;
let authToken;
let testEventId;

  beforeAll(async () => {
    // Create a test user with phone verification for the prediction routes
    const timestamp = Date.now();
    const email = `engine_test_${timestamp}@example.com`;
    const username = `engine_test_${timestamp}`;
    const passwordHash = await bcrypt.hash('testpass123', 10);

    const userResult = await db.query(
      `INSERT INTO users (email, username, password_hash, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [email, username, passwordHash]
    );
    testUser = { id: userResult.rows[0].id, email, username };

    // Mark as phone verified (tier 2) so they can use prediction routes
    await db.query(
      `UPDATE users SET verification_tier = 2 WHERE id = $1`,
      [testUser.id]
    );

    // Login to get token
    const loginRes = await request(app)
      .post('/api/login')
      .send({ email, password: 'testpass123' });
    authToken = loginRes.body.token;

    const eventResult = await db.query(
      `INSERT INTO events (title, details, closing_date) 
       VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
      ['Engine header test event', 'Event for prediction engine proxy tests']
    );
    testEventId = eventResult.rows[0].id;
  });

  afterAll(async () => {
    if (testUser) {
      await db.query('DELETE FROM users WHERE id = $1', [testUser.id]);
    }
    if (testEventId) {
      await db.query('DELETE FROM events WHERE id = $1', [testEventId]);
    }
  });

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ new_prob: 0.55, cumulative_stake: 10 })
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('market update proxy forwards engine token header', async () => {
    const res = await request(app)
      .post(`/api/events/${testEventId}/update`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ user_id: testUser.id, stake: 1, target_prob: 0.6 });

    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalled();

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers['x-engine-token']).toBe('test-engine-token');
  });
});
