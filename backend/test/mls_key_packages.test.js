const request = require('supertest');
const db = require('../src/db');

const API = 'http://localhost:3000/api';

const base64 = (bytes) => Buffer.from(bytes).toString('base64');

jest.setTimeout(30000);

describe('MLS key package listing', () => {
  const ts = Date.now();
  const user = { username: `mls_user_${ts}`, email: `mls_user_${ts}@example.com`, password: 'pw123456!' };
  let token;
  let userId;

  afterAll(async () => {
    try {
      if (userId) {
        await db.query('DELETE FROM users WHERE id = $1', [userId]);
      }
    } catch (err) {
      console.warn('Cleanup failed', err);
    }
  });

  it('publishes and lists key packages', async () => {
    const register = await request(API).post('/users/register').send(user);
    expect([200, 201]).toContain(register.statusCode);
    userId = register.body?.user?.id || register.body?.id;
    expect(userId).toBeDefined();

    const login = await request(API).post('/login').send({ email: user.email, password: user.password });
    expect(login.statusCode).toBe(200);
    token = login.body.token;
    expect(token).toBeDefined();

    const keyPackagePayload = base64('sample-key-package-payload');
    const publish = await request(API)
      .post('/mls/key-packages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientId: base64('client-id'),
        ciphersuite: 1,
        credentialType: 'basic',
        keyPackages: [keyPackagePayload]
      });
    expect(publish.statusCode).toBe(204);

    const list = await request(API)
      .get(`/mls/key-packages/${userId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.statusCode).toBe(200);
    const items = list.body?.items || [];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].keyPackage).toBe(keyPackagePayload);
  });
});
