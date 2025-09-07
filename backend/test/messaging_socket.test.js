const request = require('supertest');
const crypto = require('crypto');
const io = require('socket.io-client');

const API = 'http://localhost:3000/api';
const WS = 'http://localhost:3000';

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

jest.setTimeout(30000);

describe('Real-time messaging via Socket.IO', () => {
  const ts = Date.now();
  const alice = { username: `alice_rt_${ts}`, email: `alice_rt_${ts}@e.com`, password: 'pw12345!' };
  const bob   = { username: `bob_rt_${ts}`,   email: `bob_rt_${ts}@e.com`,   password: 'pw12345!' };
  const samplePublicKey = b64('-----BEGIN PUBLIC KEY-----\n' + 'X'.repeat(256) + '\n-----END PUBLIC KEY-----');

  let aliceId, bobId, tokenA, tokenB, conversationId;

  test('setup users, keys, conversation', async () => {
    const regA = await request(API).post('/users/register').send(alice); expect([201,200]).toContain(regA.statusCode); aliceId = regA.body.user?.id || regA.body.id;
    const regB = await request(API).post('/users/register').send(bob);   expect([201,200]).toContain(regB.statusCode); bobId   = regB.body.user?.id || regB.body.id;

    const loginA = await request(API).post('/login').send({ email: alice.email, password: alice.password }); expect(loginA.statusCode).toBe(200); tokenA = loginA.body.token;
    const loginB = await request(API).post('/login').send({ email: bob.email,   password: bob.password   }); expect(loginB.statusCode).toBe(200); tokenB = loginB.body.token;

    const kA = await request(API).post('/keys').set('Authorization', `Bearer ${tokenA}`).send({ publicKey: samplePublicKey }); expect(kA.statusCode).toBe(200);
    const kB = await request(API).post('/keys').set('Authorization', `Bearer ${tokenB}`).send({ publicKey: samplePublicKey }); expect(kB.statusCode).toBe(200);

    const conv = await request(API).post('/messages/conversations').set('Authorization', `Bearer ${tokenA}`).send({ otherUserId: bobId });
    expect(conv.statusCode).toBe(200);
    conversationId = conv.body.conversation?.id || conv.body.conversation?.conversation_id; expect(conversationId).toBeDefined();
  });

  test('socket delivery newMessage to receiver', async () => {
    const receiver = io(WS, { path: '/socket.io', transports: ['websocket'], auth: { token: tokenB } });
    const sender   = io(WS, { path: '/socket.io', transports: ['websocket'], auth: { token: tokenA } });

    const onConnect = sock => new Promise(res => sock.on('connect', res));
    await Promise.all([onConnect(receiver), onConnect(sender)]);

    // Join messaging rooms
    receiver.emit('join-messaging');
    sender.emit('join-messaging');

    // Await newMessage event
    const gotNewMessage = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for newMessage')), 5000);
      receiver.on('newMessage', (payload) => {
        try {
          expect(payload).toBeDefined();
          expect(payload.conversationId).toBe(conversationId);
          clearTimeout(timer);
          resolve(payload);
        } catch (e) { clearTimeout(timer); reject(e); }
      });
    });

    // Send message via HTTP
    const plaintext = 'hello via socket';
    const send = await request(API)
      .post(`/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        encryptedContent: b64(plaintext),
        receiverId: bobId,
        contentHash: sha256Hex(plaintext),
        senderSessionKey: b64('sessA'),
        receiverSessionKey: b64('sessB'),
        messageType: 'text'
      });
    expect(send.statusCode).toBe(201);

    const eventPayload = await gotNewMessage;
    expect(eventPayload.messageId).toBeDefined();

    sender.close();
    receiver.close();
  });
});

