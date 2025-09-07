const request = require('supertest');
const crypto = require('crypto');

const API = 'http://localhost:3000/api';

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

jest.setTimeout(20000);

describe('Messaging by username (no numeric IDs)', () => {
  const ts = Date.now();
  const alice = { username: `alice_un_${ts}`, email: `alice_un_${ts}@e.com`, password: 'pw12345!' };
  const bob   = { username: `bob_un_${ts}`,   email: `bob_un_${ts}@e.com`,   password: 'pw12345!' };
  const samplePublicKey = b64('-----BEGIN PUBLIC KEY-----\n' + 'X'.repeat(256) + '\n-----END PUBLIC KEY-----');

  let tokenA, tokenB, conversationId;

  test('register, login, store keys', async () => {
    const regA = await request(API).post('/users/register').send(alice); expect([201,200]).toContain(regA.statusCode);
    const regB = await request(API).post('/users/register').send(bob);   expect([201,200]).toContain(regB.statusCode);

    const loginA = await request(API).post('/login').send({ email: alice.email, password: alice.password }); expect(loginA.statusCode).toBe(200); tokenA = loginA.body.token;
    const loginB = await request(API).post('/login').send({ email: bob.email,   password: bob.password   }); expect(loginB.statusCode).toBe(200); tokenB = loginB.body.token;

    const kA = await request(API).post('/keys').set('Authorization', `Bearer ${tokenA}`).send({ publicKey: samplePublicKey }); expect(kA.statusCode).toBe(200);
    const kB = await request(API).post('/keys').set('Authorization', `Bearer ${tokenB}`).send({ publicKey: samplePublicKey }); expect(kB.statusCode).toBe(200);
  });

  test('create conversation by username and send without receiverId', async () => {
    const conv = await request(API)
      .post('/messages/conversations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ otherUsername: bob.username });
    expect(conv.statusCode).toBe(200);
    conversationId = conv.body.conversation?.id || conv.body.conversation?.conversation_id;
    expect(conversationId).toBeDefined();

    const plaintext = 'hello bob via username';
    const send = await request(API)
      .post(`/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        encryptedContent: b64(plaintext),
        // receiverId omitted intentionally; server infers from conversation
        contentHash: sha256Hex(plaintext),
        senderSessionKey: b64('sessA'),
        receiverSessionKey: b64('sessB'),
        messageType: 'text'
      });
    expect(send.statusCode).toBe(201);

    // Bob fetches messages
    const list = await request(API)
      .get(`/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.body.messages)).toBe(true);
    expect(list.body.messages.length).toBeGreaterThan(0);
  });
});

