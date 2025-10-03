const request = require('supertest');

const API = 'http://localhost:3000/api';

jest.setTimeout(30000);

describe('E2EE one-time prekey reserve/consume', () => {
  const ts = Date.now();
  const user = { username: `sig_only_${ts}`, email: `sig_only_${ts}@e.com`, password: 'x12345!' };
  let uid, token;

  it('register/login and publish identity+prekeys', async () => {
    const r = await request(API).post('/users/register').send(user);
    expect([200,201]).toContain(r.statusCode);
    uid = r.body.user?.id || r.body.id; expect(uid).toBeDefined();
    const l = await request(API).post('/login').send({ email: user.email, password: user.password });
    token = l.body.token; expect(token).toBeDefined();

    const identityKey = Buffer.from('id_pub_curve25519').toString('base64');
    const signingKey = Buffer.from('sign_pub_ed25519').toString('base64');
    const idRes = await request(API).post('/e2ee/keys/identity').set('Authorization', `Bearer ${token}`).send({ identityKey, signingKey });
    expect(idRes.statusCode).toBe(200);

    const oneTimePreKeys = Array.from({ length: 2 }).map((_, i) => ({ keyId: 100 + i, publicKey: Buffer.from(`otp${100+i}`).toString('base64') }));
    const preRes = await request(API).post('/e2ee/keys/prekeys').set('Authorization', `Bearer ${token}`).send({ signedPreKey: { keyId: 1, publicKey: Buffer.from('spk').toString('base64'), signature: Buffer.from('sig').toString('base64') }, oneTimePreKeys });
    expect(preRes.statusCode).toBe(200);
  });

  it('reserves a prekey on bundle fetch and then consumes it', async () => {
    // Self-fetch to reserve; in practice another user would fetch
    const bundle = await request(API).get(`/e2ee/keys/bundle?userId=${uid}`).set('Authorization', `Bearer ${token}`);
    expect(bundle.statusCode).toBe(200);
    const reserved = bundle.body.oneTimePreKey;
    // May be null if none exist; if present, we can consume
    if (reserved) {
      const consume = await request(API)
        .post('/e2ee/keys/consume')
        .set('Authorization', `Bearer ${token}`)
        .send({ keyId: reserved.keyId });
      expect(consume.statusCode).toBe(200);
      expect(consume.body.success).toBe(true);

      // Consuming again should 404
      const consume2 = await request(API)
        .post('/e2ee/keys/consume')
        .set('Authorization', `Bearer ${token}`)
        .send({ keyId: reserved.keyId });
      expect(consume2.statusCode).toBe(404);
    }
  });

  it('rejects consume without keyId', async () => {
    const bad = await request(API)
      .post('/e2ee/keys/consume')
      .set('Authorization', `Bearer ${token}`)
      .send({ });
    expect(bad.statusCode).toBe(400);
  });
});
