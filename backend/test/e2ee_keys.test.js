const request = require('supertest');

const API = 'http://localhost:3000/api';

jest.setTimeout(30000);

// Legacy Signal endpoints have been retired in favor of MLS. Skip until MLS equivalents land.
describe.skip('E2EE Signal Key Bundle Endpoints', () => {
  const ts = Date.now();
  const alice = { username: `sig_alice_${ts}`, email: `sig_alice_${ts}@e.com`, password: 'x12345!' };
  const bob = { username: `sig_bob_${ts}`, email: `sig_bob_${ts}@e.com`, password: 'x12345!' };
  let aliceId, bobId;
  let aliceToken, bobToken;

  it('register and login users', async () => {
    const ra = await request(API).post('/users/register').send(alice);
    expect([200,201]).toContain(ra.statusCode);
    aliceId = ra.body.user?.id || ra.body.id; expect(aliceId).toBeDefined();
    const rb = await request(API).post('/users/register').send(bob);
    expect([200,201]).toContain(rb.statusCode);
    bobId = rb.body.user?.id || rb.body.id; expect(bobId).toBeDefined();

    const la = await request(API).post('/login').send({ email: alice.email, password: alice.password });
    aliceToken = la.body.token; expect(aliceToken).toBeDefined();
    const lb = await request(API).post('/login').send({ email: bob.email, password: bob.password });
    bobToken = lb.body.token; expect(bobToken).toBeDefined();
  });

  it('publish identity + prekeys for Alice and fetch bundle as Bob', async () => {
    const identityKey = Buffer.from('id_pub_curve25519').toString('base64');
    const signingKey = Buffer.from('sign_pub_ed25519').toString('base64');

    const idRes = await request(API)
      .post('/e2ee/keys/identity')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ identityKey, signingKey });
    expect(idRes.statusCode).toBe(200);
    expect(idRes.body.success).toBe(true);

    const prekeys = await request(API)
      .post('/e2ee/keys/prekeys')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ signedPreKey: { keyId: 1, publicKey: Buffer.from('spk').toString('base64'), signature: Buffer.from('sig').toString('base64') }, oneTimePreKeys: [ { keyId: 101, publicKey: Buffer.from('otp101').toString('base64') }, { keyId: 102, publicKey: Buffer.from('otp102').toString('base64') } ] });
    expect(prekeys.statusCode).toBe(200);
    expect(prekeys.body.success).toBe(true);

    const bundle = await request(API)
      .get(`/e2ee/keys/bundle?userId=${aliceId}`)
      .set('Authorization', `Bearer ${bobToken}`);
    expect(bundle.statusCode).toBe(200);
    expect(typeof bundle.body.identityKey).toBe('string');
    // Signed prekey may exist
    expect(bundle.body.signedPreKey).toBeTruthy();
    // One-time prekey is best-effort; may be present on first fetch
    if (bundle.body.oneTimePreKey) {
      expect(typeof bundle.body.oneTimePreKey.keyId).toBe('number');
      expect(typeof bundle.body.oneTimePreKey.publicKey).toBe('string');
    }
  });
});
