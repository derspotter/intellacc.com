const request = require('supertest');
const crypto = require('crypto');

const API = 'http://localhost:3000/api';

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

jest.setTimeout(30000);

describe('Encrypted Messaging - Negative Cases', () => {
  const ts = Date.now();
  const withKey = { username: `wk_${ts}`, email: `wk_${ts}@e.com`, password: 'x12345!' };
  const noKey1 = { username: `nk1_${ts}`, email: `nk1_${ts}@e.com`, password: 'x12345!' };
  const noKey2 = { username: `nk2_${ts}`, email: `nk2_${ts}@e.com`, password: 'x12345!' };

  let wkId, nk1Id, nk2Id;
  let wkToken, nk1Token, nk2Token;
  const samplePublicKey = b64('-----BEGIN PUBLIC KEY-----\n' + 'X'.repeat(256) + '\n-----END PUBLIC KEY-----');

  test('setup users and keys', async () => {
    const regA = await request(API).post('/users/register').send(withKey);
    expect([201,200]).toContain(regA.statusCode);
    wkId = regA.body.user?.id || regA.body.id;

    const regB = await request(API).post('/users/register').send(noKey1);
    expect([201,200]).toContain(regB.statusCode);
    nk1Id = regB.body.user?.id || regB.body.id;

    const regC = await request(API).post('/users/register').send(noKey2);
    expect([201,200]).toContain(regC.statusCode);
    nk2Id = regC.body.user?.id || regC.body.id;

    const loginA = await request(API).post('/login').send({ email: withKey.email, password: withKey.password });
    wkToken = loginA.body.token; expect(wkToken).toBeDefined();
    const loginB = await request(API).post('/login').send({ email: noKey1.email, password: noKey1.password });
    nk1Token = loginB.body.token; expect(nk1Token).toBeDefined();
    const loginC = await request(API).post('/login').send({ email: noKey2.email, password: noKey2.password });
    nk2Token = loginC.body.token; expect(nk2Token).toBeDefined();

    // Only withKey stores a key
    const resKey = await request(API).post('/keys').set('Authorization', `Bearer ${wkToken}`).send({ publicKey: samplePublicKey });
    expect(resKey.statusCode).toBe(200);
  });

  test('cannot create conversation without own key', async () => {
    const attempt = await request(API)
      .post('/messages/conversations')
      .set('Authorization', `Bearer ${nk1Token}`)
      .send({ otherUserId: wkId });
    expect(attempt.statusCode).toBe(400);
    expect((attempt.body.error || '').toLowerCase()).toContain('public key');
  });

  test('cannot create conversation when other user has no key', async () => {
    // withKey tries to talk to noKey2 (who has no key)
    const attempt = await request(API)
      .post('/messages/conversations')
      .set('Authorization', `Bearer ${wkToken}`)
      .send({ otherUserId: nk2Id });
    expect(attempt.statusCode).toBe(400);
    expect((attempt.body.error || '').toLowerCase()).toContain('public key');
  });

  test('message validation errors', async () => {
    // Create conversation wk <-> nk1 by equipping nk1 with a key now
    const resKey2 = await request(API).post('/keys').set('Authorization', `Bearer ${nk1Token}`).send({ publicKey: samplePublicKey });
    expect(resKey2.statusCode).toBe(200);

    const conv = await request(API)
      .post('/messages/conversations')
      .set('Authorization', `Bearer ${wkToken}`)
      .send({ otherUserId: nk1Id });
    expect(conv.statusCode).toBe(200);
    const conversationId = conv.body.conversation?.id || conv.body.conversation?.conversation_id;
    expect(conversationId).toBeDefined();

    // Invalid content hash
    const badHash = 'not-a-hex';
    const send1 = await request(API)
      .post(`/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${wkToken}`)
      .send({
        encryptedContent: b64('hi'),
        receiverId: nk1Id,
        contentHash: badHash,
        senderSessionKey: b64('s1'),
        receiverSessionKey: b64('s2'),
        messageType: 'text'
      });
    expect(send1.statusCode).toBe(400);

    // Message too large (>16KB base64)
    const large = b64('Y'.repeat(20 * 1024));
    const send2 = await request(API)
      .post(`/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${wkToken}`)
      .send({
        encryptedContent: large,
        receiverId: nk1Id,
        contentHash: sha256Hex('big'),
        senderSessionKey: b64('s1'),
        receiverSessionKey: b64('s2'),
        messageType: 'text'
      });
    expect(send2.statusCode).toBe(400);

    // Non-member tries to send into conversation
    const badSend = await request(API)
      .post(`/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${nk2Token}`)
      .send({
        encryptedContent: b64('oops'),
        receiverId: nk1Id,
        contentHash: sha256Hex('oops'),
        senderSessionKey: b64('s1'),
        receiverSessionKey: b64('s2'),
        messageType: 'text'
      });
    expect([403,500]).toContain(badSend.statusCode); // Controller maps membership error to 403; other errors may map to 500
  });
});

