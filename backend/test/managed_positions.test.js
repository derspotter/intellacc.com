const request = require('supertest');
const express = require('express');

// Isolated HTTP tests: never start the application or connect to its database.
jest.mock('../src/index', () => ({}));
jest.mock('../src/middleware/auth', () => (req, res, next) => {
  if (!req.headers.authorization) return res.sendStatus(401);
  req.user = { id: 42, isAgent: req.headers['x-agent'] === 'true', scopes: [] };
  next();
});
jest.mock('../src/middleware/verification', () => ({
  requirePhoneVerified: (req, res, next) => req.headers['x-unverified'] ? res.sendStatus(403) : next()
}));

const app = express();
app.use(express.json());
app.use('/events/:eventId/managed-position', require('../src/routes/managedPositions'));

describe('managed position authorization and proxy', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ enabled: true }) });
  });
  afterAll(() => { global.fetch = originalFetch; });

  test('uses authenticated identity and ignores injected policy fields', async () => {
    const result = await request(app).post('/events/7/managed-position').set('Authorization', 'session')
      .send({ enabled: true, belief_prob: 0.3, kelly_fraction: 0.25, user_id: 999, last_error: 'injected' });
    expect(result.status).toBe(200);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      user_id: 42, enabled: true, belief_prob: 0.3, kelly_fraction: 0.25
    });
  });

  test('GET is private and ignores a user_id query override', async () => {
    expect((await request(app).get('/events/7/managed-position')).status).toBe(401);
    const result = await request(app).get('/events/7/managed-position?user_id=999').set('Authorization', 'session');
    expect(result.status).toBe(200);
    expect(global.fetch.mock.calls[0][0]).toMatch(/\?user_id=42$/);
  });

  test('unverified users can pause but cannot enable', async () => {
    expect((await request(app).post('/events/7/managed-position').set('Authorization', 'session')
      .set('x-unverified', 'true').send({ enabled: true, belief_prob: 0.3, kelly_fraction: 0.25 })).status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await request(app).post('/events/7/managed-position').set('Authorization', 'session')
      .set('x-unverified', 'true').send({ enabled: false })).status).toBe(200);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ user_id: 42, enabled: false });
  });

  test('agent keys need market:trade scope', async () => {
    const result = await request(app).post('/events/7/managed-position').set('Authorization', 'session')
      .set('x-agent', 'true').send({ enabled: false });
    expect(result.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    { enabled: 'false' }, { enabled: true, belief_prob: 0, kelly_fraction: 0.25 },
    { enabled: true, belief_prob: 1, kelly_fraction: 0.25 },
    { enabled: true, belief_prob: '0.3', kelly_fraction: 0.25 },
    { enabled: true, belief_prob: 0.3, kelly_fraction: 0.3 }
  ])('rejects invalid settings: %j', async (body) => {
    expect((await request(app).post('/events/7/managed-position').set('Authorization', 'session').send(body)).status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('preserves engine lifecycle failures', async () => {
    global.fetch.mockResolvedValue({ status: 400, json: async () => ({ error: 'Market is closed or resolved' }) });
    const result = await request(app).post('/events/7/managed-position').set('Authorization', 'session')
      .send({ enabled: true, belief_prob: 0.3, kelly_fraction: 0.25 });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('Market is closed or resolved');
  });
});
