const request = require('supertest');
const crypto = require('crypto');

// Use base URL since src/index.js does not export an Express app
const API = 'http://localhost:3000/api';

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

describe('E2E Encrypted Messaging', () => {
  const ts = Date.now();
  const userA = {
    username: `alice_${ts}`,
    email: `alice_${ts}@example.com`,
    password: 'password123!'
  };
  const userB = {
    username: `bob_${ts}`,
    email: `bob_${ts}@example.com`,
    password: 'password123!'
  };

  let userAId, userBId;
  let tokenA, tokenB;
  let conversationId;
  let messageId;

  // A reasonably long base64 string to satisfy simple format checks
  const samplePublicKey = b64('-----BEGIN PUBLIC KEY-----\n' + 'X'.repeat(256) + '\n-----END PUBLIC KEY-----');

  test('register and login two users', async () => {
    // Register A
    const regA = await request(API).post('/users/register').send(userA);
    expect([201, 200]).toContain(regA.statusCode);
    userAId = regA.body.user?.id || regA.body.id;
    expect(userAId).toBeDefined();

    // Register B
    const regB = await request(API).post('/users/register').send(userB);
    expect([201, 200]).toContain(regB.statusCode);
    userBId = regB.body.user?.id || regB.body.id;
    expect(userBId).toBeDefined();

    // Login A
    const loginA = await request(API).post('/login').send({ email: userA.email, password: userA.password });
    expect(loginA.statusCode).toBe(200);
    tokenA = loginA.body.token;
    expect(tokenA).toBeDefined();

    // Login B
    const loginB = await request(API).post('/login').send({ email: userB.email, password: userB.password });
    expect(loginB.statusCode).toBe(200);
    tokenB = loginB.body.token;
    expect(tokenB).toBeDefined();
  }, 20000);

  test('store public keys for both users', async () => {
    const resA = await request(API)
      .post('/keys')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ publicKey: samplePublicKey });
    expect(resA.statusCode).toBe(200);
    expect(resA.body?.success).toBe(true);

    const resB = await request(API)
      .post('/keys')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ publicKey: samplePublicKey });
    expect(resB.statusCode).toBe(200);
    expect(resB.body?.success).toBe(true);
  }, 20000);

  test('create conversation and send encrypted message', async () => {
    // Create conversation (A -> B)
    const conv = await request(API)
      .post('/messages/conversations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ otherUserId: userBId });
    expect(conv.statusCode).toBe(200);
    conversationId = conv.body.conversation?.id || conv.body.conversation?.conversation_id;
    expect(conversationId).toBeDefined();

    // Prepare encrypted payload (simulated)
    const plaintext = 'hello bob from alice';
    const encryptedContent = b64(plaintext); // simulate ciphertext as base64
    const contentHash = sha256Hex(plaintext);
    const senderSessionKey = b64('sessA');
    const receiverSessionKey = b64('sessB');

    const send = await request(API)
      .post(`/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        encryptedContent,
        receiverId: userBId,
        contentHash,
        senderSessionKey,
        receiverSessionKey,
        messageType: 'text'
      });
    expect(send.statusCode).toBe(201);
    const msg = send.body.message;
    expect(msg).toBeDefined();
    expect(msg.contentHash).toBe(contentHash);
    expect(msg.encryptedContent).toBe(encryptedContent);
    messageId = msg.id;
    expect(messageId).toBeDefined();
  }, 20000);

  // Note: contentHash remains required by DB; client should provide it.

  test('receiver fetches, unread count increments, then mark as read', async () => {
    // Unread count before read
    const unread1 = await request(API)
      .get('/messages/unread-count')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(unread1.statusCode).toBe(200);
    expect(typeof unread1.body.count).toBe('number');
    // We cannot assert exact count reliably, but it should be >= 1
    expect(unread1.body.count).toBeGreaterThanOrEqual(1);

    // Receiver fetches messages
    const list = await request(API)
      .get(`/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(list.statusCode).toBe(200);
    const items = list.body.messages || [];
    expect(Array.isArray(items)).toBe(true);
    const found = items.find(m => m.id === messageId || m.message_id === messageId);
    expect(found).toBeTruthy();

    // Mark as read
    const read = await request(API)
      .post('/messages/read')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ messageIds: [messageId] });
    expect(read.statusCode).toBe(200);
    expect(read.body.success).toBe(true);

    // Unread count after read
    const unread2 = await request(API)
      .get('/messages/unread-count')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(unread2.statusCode).toBe(200);
    expect(typeof unread2.body.count).toBe('number');
  }, 20000);
});
