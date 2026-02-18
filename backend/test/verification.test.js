const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
const paymentVerificationService = require('../src/services/paymentVerificationService');

jest.setTimeout(30000);

const createUser = async () => {
  const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const email = `verification_${unique}@example.com`;
  const username = `verification_${unique}`;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  const token = loginRes.body.token;
  const profileRes = await request(app)
    .get('/api/me')
    .set('Authorization', `Bearer ${token}`);

  return {
    id: profileRes.body.id,
    email,
    username,
    token
  };
};

const cleanupUsers = async (userIds) => {
  if (!userIds.length) return;
  const placeholders = userIds.map((_, index) => `$${index + 1}`).join(', ');
  await db.query(`DELETE FROM users WHERE id IN (${placeholders})`, userIds);
};

const createdEvents = [];

const createEvent = async () => {
  const event = await db.query(
    `INSERT INTO events (title, details, closing_date)
     VALUES ($1, $2, NOW() + INTERVAL '2 hours')
     RETURNING id`,
    [`Verification test event ${Date.now()}_${Math.random().toString(16).slice(2)}`, 'Verification test event for middleware bypass']
  );

  createdEvents.push(event.rows[0].id);
  return event.rows[0];
};

describe('Tiered verification routes and middleware', () => {
  const users = [];

  afterAll(async () => {
    await cleanupUsers(users);
    if (createdEvents.length > 0) {
      const eventPlaceholders = createdEvents.map((_, index) => `$${index + 1}`).join(', ');
      await db.query(`DELETE FROM events WHERE id IN (${eventPlaceholders})`, createdEvents);
    }
  });

  test('returns verification status for authenticated user', async () => {
    const user = await createUser();
    users.push(user.id);

    const statusRes = await request(app)
      .get('/api/verification/status')
      .set('Authorization', `Bearer ${user.token}`);

    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.body.current_tier).toBe(0);
    expect(statusRes.body.current_tier_name).toBe('none');
    expect(statusRes.body.next_tier).toEqual({
      tier: 1,
      name: 'email',
      unlocks: ['Post', 'Comment', 'Send messages']
    });
    expect(typeof statusRes.body.provider_capabilities).toBe('object');
    expect(statusRes.body.provider_capabilities.phone).toMatchObject({
      provider: expect.any(String),
      configured: expect.any(Boolean),
      available: expect.any(Boolean),
      required: expect.any(Boolean)
    });
    expect(statusRes.body.provider_capabilities.payment).toMatchObject({
      provider: expect.any(String),
      configured: expect.any(Boolean),
      available: expect.any(Boolean),
      required: expect.any(Boolean)
    });
    expect(statusRes.body.provider_capabilities.phone.reason === null || typeof statusRes.body.provider_capabilities.phone.reason === 'string').toBe(true);
    expect(statusRes.body.provider_capabilities.payment.reason === null || typeof statusRes.body.provider_capabilities.payment.reason === 'string').toBe(true);
    expect(statusRes.body.email_verified).toBe(false);
    expect(statusRes.body.phone_verified).toBe(false);
    expect(statusRes.body.payment_verified).toBe(false);
  });

  test('reports provider availability from verification status', async () => {
    const user = await createUser();
    users.push(user.id);

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const statusRes = await request(app)
        .get('/api/verification/status')
        .set('Authorization', `Bearer ${user.token}`);

      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.body.provider_capabilities.phone.available).toBe(false);
      expect(statusRes.body.provider_capabilities.payment.available).toBe(false);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('enforces email verification before posting', async () => {
    const user = await createUser();
    users.push(user.id);

    const blockedRes = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ content: 'unverified user post' });

    expect(blockedRes.statusCode).toBe(403);
    expect(blockedRes.body.error).toBe('Higher verification required');
    expect(blockedRes.body.required_tier).toBe(1);
    expect(blockedRes.body.required_tier_name).toBe('email');

    await db.query('UPDATE users SET verification_tier = 1 WHERE id = $1', [user.id]);

    const allowedRes = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ content: 'verified user post' });

    expect(allowedRes.statusCode).toBe(201);
    expect(allowedRes.body.id).toBeGreaterThan(0);
  });

  test('enforces phone verification before prediction actions', async () => {
    const user = await createUser();
    users.push(user.id);

    await db.query('UPDATE users SET verification_tier = 1 WHERE id = $1', [user.id]);

    const blockedPredict = await request(app)
      .post('/api/predict')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ event_id: 1, prediction: 'yes' });

    expect(blockedPredict.statusCode).toBe(403);
    expect(blockedPredict.body.required_tier).toBe(2);

    const phoneNumber = `+1555${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
    const startRes = await request(app)
      .post('/api/verification/phone/start')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ phoneNumber });

    expect(startRes.statusCode).toBe(200);
    expect(startRes.body.provider).toBe('dev');
    expect(startRes.body.dev_code).toBe(process.env.DEV_PHONE_CODE || '000000');

    const wrongCodeRes = await request(app)
      .post('/api/verification/phone/confirm')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ phoneNumber, code: '123456' });

    expect(wrongCodeRes.statusCode).toBe(400);

    const correctCodeRes = await request(app)
      .post('/api/verification/phone/confirm')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ phoneNumber, code: process.env.DEV_PHONE_CODE || '000000' });

    expect(correctCodeRes.statusCode).toBe(200);

    const statusRes = await request(app)
      .get('/api/verification/status')
      .set('Authorization', `Bearer ${user.token}`);

    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.body.current_tier).toBe(2);
    expect(statusRes.body.phone_verified).toBe(true);
  });

  test('stripe webhook is robust for unsupported payloads and duplicate setup intents', async () => {
    const user = await createUser();
    users.push(user.id);
    await db.query('UPDATE users SET verification_tier = 2 WHERE id = $1', [user.id]);

    const unknownEvent = await request(app)
      .post('/api/webhooks/stripe')
      .send({ type: 'invoice.paid', data: {} });
    expect(unknownEvent.statusCode).toBe(200);
    expect(unknownEvent.body.ignored).toBe(true);

    const invalidPayload = await request(app)
      .post('/api/webhooks/stripe')
      .send({});
    expect(invalidPayload.statusCode).toBe(400);
    expect(invalidPayload.body.error).toMatch(/Invalid Stripe webhook payload/i);

    const setupIntent = {
      id: 'seti_test_123',
      customer: 'cus_test_123',
      metadata: { user_id: String(user.id) }
    };

    const first = await paymentVerificationService.handleSetupIntentSucceeded(setupIntent, 'evt_1');
    expect(first.status).toBe('verified');
    expect(first.alreadyVerified).toBe(false);

    const second = await paymentVerificationService.handleSetupIntentSucceeded(setupIntent, 'evt_1');
    expect(second.status).toBe('already_verified');
    expect(second.alreadyVerified).toBe(true);

    const userAfter = await db.query('SELECT verification_tier FROM users WHERE id = $1', [user.id]);
    expect(userAfter.rows[0].verification_tier).toBe(3);
  });

  test('blocks phone verification when Twilio is missing in production', async () => {
    const user = await createUser();
    users.push(user.id);

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    await db.query('UPDATE users SET verification_tier = 1 WHERE id = $1', [user.id]);

    try {
      const phoneStartRes = await request(app)
        .post('/api/verification/phone/start')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ phoneNumber: '+15555550000' });

      expect(phoneStartRes.statusCode).toBe(400);
      expect(phoneStartRes.body.error).toMatch(/Twilio verification is not configured/i);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('blocks payment verification when Stripe is missing in production', async () => {
    const user = await createUser();
    users.push(user.id);

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    await db.query('UPDATE users SET verification_tier = 2 WHERE id = $1', [user.id]);

    try {
      const setupRes = await request(app)
        .post('/api/verification/payment/setup')
        .set('Authorization', `Bearer ${user.token}`);

      expect(setupRes.statusCode).toBe(400);
      expect(setupRes.body.error).toMatch(/Stripe verification is not configured/i);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('treats phone verification as disabled when explicitly turned off', async () => {
    const user = await createUser();
    users.push(user.id);

    const originalNodeEnv = process.env.NODE_ENV;
    const originalFlag = process.env.PHONE_VERIFICATION_ENABLED;
    process.env.NODE_ENV = 'production';
    process.env.PHONE_VERIFICATION_ENABLED = 'false';

    try {
      const phoneStartRes = await request(app)
        .post('/api/verification/phone/start')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ phoneNumber: '+15555550000' });

      expect(phoneStartRes.statusCode).toBe(400);
      expect(phoneStartRes.body.error).toBe('Phone verification is disabled by configuration.');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (typeof originalFlag === 'undefined') {
        delete process.env.PHONE_VERIFICATION_ENABLED;
      } else {
        process.env.PHONE_VERIFICATION_ENABLED = originalFlag;
      }
    }
  });

  test('treats payment verification as disabled when explicitly turned off', async () => {
    const user = await createUser();
    users.push(user.id);

    const originalNodeEnv = process.env.NODE_ENV;
    const originalFlag = process.env.PAYMENT_VERIFICATION_ENABLED;
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_VERIFICATION_ENABLED = 'false';

    try {
      const setupRes = await request(app)
        .post('/api/verification/payment/setup')
        .set('Authorization', `Bearer ${user.token}`);

      expect(setupRes.statusCode).toBe(400);
      expect(setupRes.body.error).toBe('Payment verification is disabled by configuration.');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (typeof originalFlag === 'undefined') {
        delete process.env.PAYMENT_VERIFICATION_ENABLED;
      } else {
        process.env.PAYMENT_VERIFICATION_ENABLED = originalFlag;
      }
    }
  });

  test('bypasses phone verification when phone verification is disabled', async () => {
    const user = await createUser();
    users.push(user.id);

    const originalFlag = process.env.PHONE_VERIFICATION_ENABLED;
    process.env.PHONE_VERIFICATION_ENABLED = 'false';

    const event = await createEvent();

    try {
      await db.query('UPDATE users SET verification_tier = 1 WHERE id = $1', [user.id]);

      const predictionRes = await request(app)
        .post('/api/predict')
        .set('Authorization', `Bearer ${user.token}`)
        .send({
          event_id: event.id,
          prediction_value: 'yes',
          confidence: 77
        });

      expect(predictionRes.statusCode).toBe(201);
      expect(predictionRes.body).toHaveProperty('id');
    } finally {
      if (typeof originalFlag === 'undefined') {
        delete process.env.PHONE_VERIFICATION_ENABLED;
      } else {
        process.env.PHONE_VERIFICATION_ENABLED = originalFlag;
      }
    }
  });

  test('bypasses payment verification when payment verification is disabled', async () => {
    const user = await createUser();
    users.push(user.id);

    const originalFlag = process.env.PAYMENT_VERIFICATION_ENABLED;
    process.env.PAYMENT_VERIFICATION_ENABLED = 'false';

    try {
      await db.query('UPDATE users SET verification_tier = 2 WHERE id = $1', [user.id]);

      const createRes = await request(app)
        .post('/api/events')
        .set('Authorization', `Bearer ${user.token}`)
        .send({
          title: `Event create test ${Date.now()}`,
          details: 'Event created during verification bypass test',
          closing_date: new Date(Date.now() + 3600000).toISOString()
        });

      expect(createRes.statusCode).toBe(201);
      expect(createRes.body).toHaveProperty('id');
    } finally {
      if (typeof originalFlag === 'undefined') {
        delete process.env.PAYMENT_VERIFICATION_ENABLED;
      } else {
        process.env.PAYMENT_VERIFICATION_ENABLED = originalFlag;
      }
    }
  });

  test('hides upgrade path when higher tiers are disabled', async () => {
    const user = await createUser();
    users.push(user.id);

    const originalPhoneFlag = process.env.PHONE_VERIFICATION_ENABLED;
    const originalPaymentFlag = process.env.PAYMENT_VERIFICATION_ENABLED;
    process.env.PHONE_VERIFICATION_ENABLED = 'false';
    process.env.PAYMENT_VERIFICATION_ENABLED = 'true';

    try {
      await db.query('UPDATE users SET verification_tier = 1 WHERE id = $1', [user.id]);

      const statusRes = await request(app)
        .get('/api/verification/status')
        .set('Authorization', `Bearer ${user.token}`);

      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.body.next_tier).toBeNull();
    } finally {
      if (typeof originalPhoneFlag === 'undefined') {
        delete process.env.PHONE_VERIFICATION_ENABLED;
      } else {
        process.env.PHONE_VERIFICATION_ENABLED = originalPhoneFlag;
      }
      if (typeof originalPaymentFlag === 'undefined') {
        delete process.env.PAYMENT_VERIFICATION_ENABLED;
      } else {
        process.env.PAYMENT_VERIFICATION_ENABLED = originalPaymentFlag;
      }
    }
  });

  test('enforces email verification before MLS and messaging attachment access', async () => {
    const user = await createUser();
    users.push(user.id);

    const blockedMls = await request(app)
      .get('/api/mls/groups')
      .set('Authorization', `Bearer ${user.token}`);

    expect(blockedMls.statusCode).toBe(403);
    expect(blockedMls.body.error).toBe('Higher verification required');
    expect(blockedMls.body.required_tier).toBe(1);
    expect(blockedMls.body.required_tier_name).toBe('email');

    const blockedMessageUpload = await request(app)
      .post('/api/attachments/message')
      .set('Authorization', `Bearer ${user.token}`)
      .field('mls_group_id', 1);

    expect(blockedMessageUpload.statusCode).toBe(403);
    expect(blockedMessageUpload.body.error).toBe('Higher verification required');
    expect(blockedMessageUpload.body.required_tier).toBe(1);
    expect(blockedMessageUpload.body.required_tier_name).toBe('email');

    await db.query('UPDATE users SET verification_tier = 1 WHERE id = $1', [user.id]);

    const allowedMls = await request(app)
      .get('/api/mls/groups')
      .set('Authorization', `Bearer ${user.token}`);

    expect(allowedMls.statusCode).toBe(200);
    expect(Array.isArray(allowedMls.body)).toBe(true);
  });
});
