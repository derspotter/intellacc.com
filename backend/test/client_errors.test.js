const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

// Error-reporting sink (self-hosted error tracking). Unauthenticated by
// design; server truncates every field and never fails user-visibly.

describe('POST /api/errors', () => {
  const marker = `client_errors_test_${Date.now()}`;

  afterAll(async () => {
    await db.query('DELETE FROM client_errors WHERE message LIKE $1', [`${marker}%`]);
  });

  test('stores an anonymous report and returns 204', async () => {
    const res = await request(app)
      .post('/api/errors')
      .send({ message: `${marker} boom`, stack: 'at x (y.js:1)', url: 'https://intellacc.com/#home' });

    expect(res.statusCode).toBe(204);

    const row = (await db.query(
      'SELECT user_id, message, stack, url FROM client_errors WHERE message = $1',
      [`${marker} boom`]
    )).rows[0];
    expect(row).toBeTruthy();
    expect(row.user_id).toBeNull();
    expect(row.stack).toBe('at x (y.js:1)');
  });

  test('rejects a missing message', async () => {
    const res = await request(app).post('/api/errors').send({ stack: 'no message' });
    expect(res.statusCode).toBe(400);
  });

  test('truncates oversized fields server-side', async () => {
    const res = await request(app)
      .post('/api/errors')
      .send({ message: `${marker} ` + 'M'.repeat(2000), stack: 'S'.repeat(10000), url: 'U'.repeat(1000) });

    expect(res.statusCode).toBe(204);
    const row = (await db.query(
      'SELECT message, stack, url FROM client_errors WHERE message LIKE $1 ORDER BY id DESC LIMIT 1',
      [`${marker} MM%`]
    )).rows[0];
    expect(row.message.length).toBe(500);
    expect(row.stack.length).toBe(4000);
    expect(row.url.length).toBe(300);
  });
});
