const request = require('supertest');

jest.mock('../src/utils/registration', () => {
  const actual = jest.requireActual('../src/utils/registration');
  return {
    ...actual,
    isRegistrationApprovalRequired: () => true,
    REGISTRATION_APPROVAL_MESSAGE: 'Registration is pending admin approval.'
  };
});

const { app } = require('../src/index');
const db = require('../src/db');
const { createApprovalRequest } = require('../src/services/registrationApprovalService');
const emailVerificationService = require('../src/services/emailVerificationService');
const ipIntelService = require('../src/services/ipIntelService');

jest.setTimeout(30000);

const createPendingUser = async ({ ip, userAgent } = {}) => {
  const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const username = `pending_${unique}`;
  const email = `${username}@example.com`;
  const password = 'testpass123';

  let req = request(app).post('/api/users/register');
  if (ip) req = req.set('X-Forwarded-For', ip);
  if (userAgent) req = req.set('User-Agent', userAgent);
  const registerRes = await req.send({ username, email, password });

  return {
    registerRes,
    user: {
      username,
      email,
      password
    }
  };
};

describe('Admin registration approval flow', () => {
  const createdUserIds = [];
  const sendEmailSpy = jest.spyOn(emailVerificationService, 'sendEmail');
  const originalMaxPending = process.env.REGISTRATION_APPROVAL_MAX_PENDING;

  beforeAll(async () => {
    sendEmailSpy.mockClear();
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT TRUE`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`);
    await db.query(`UPDATE users SET is_approved = TRUE WHERE is_approved IS NULL`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS registration_approval_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        approver_email VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        used_at TIMESTAMP WITH TIME ZONE,
        CONSTRAINT chk_registration_approval_token_status
          CHECK (status IN ('pending', 'approved', 'expired'))
      )
    `);
    await db.query(`
      ALTER TABLE registration_approval_tokens
      ADD COLUMN IF NOT EXISTS token TEXT
    `);
    await db.query(`
      ALTER TABLE registration_approval_tokens
      ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMP WITH TIME ZONE
    `);
    await db.query(`
      ALTER TABLE registration_approval_tokens
      ADD COLUMN IF NOT EXISTS signup_ip INET,
      ADD COLUMN IF NOT EXISTS signup_user_agent TEXT,
      ADD COLUMN IF NOT EXISTS signup_asn INTEGER
    `);
    await db.query(`ALTER TABLE registration_approval_tokens DROP CONSTRAINT IF EXISTS chk_registration_approval_token_status`);
    await db.query(`
      ALTER TABLE registration_approval_tokens
      ADD CONSTRAINT chk_registration_approval_token_status
      CHECK (status IN ('pending', 'approved', 'rejected', 'expired'))
    `);
  });

  beforeEach(async () => {
    sendEmailSpy.mockClear();
    process.env.REGISTRATION_APPROVAL_MAX_PENDING = '0';
    await db.query(`DELETE FROM registration_approval_tokens WHERE status = 'pending'`);
  });

  afterAll(async () => {
    if (originalMaxPending === undefined) {
      delete process.env.REGISTRATION_APPROVAL_MAX_PENDING;
    } else {
      process.env.REGISTRATION_APPROVAL_MAX_PENDING = originalMaxPending;
    }

    if (!createdUserIds.length) return;
    const placeholders = createdUserIds.map((_, index) => `$${index + 1}`).join(', ');
    await db.query(`DELETE FROM users WHERE id IN (${placeholders})`, createdUserIds);
  });

  test('blocks login for users awaiting approval', async () => {
    const { registerRes, user } = await createPendingUser();

    expect(registerRes.statusCode).toBe(201);
    expect(registerRes.body.requiresApproval).toBe(true);
    expect(registerRes.body.message).toBe('Registration is pending admin approval.');

    const userResult = await db.query('SELECT id FROM users WHERE email = $1', [user.email]);
    expect(userResult.rows.length).toBe(1);

    createdUserIds.push(userResult.rows[0].id);

    const loginRes = await request(app)
      .post('/api/login')
      .send({ email: user.email, password: user.password });

    expect(loginRes.statusCode).toBe(403);
    expect(loginRes.body.requiresApproval).toBe(true);
    expect(loginRes.body.message).toBe('Registration is pending admin approval.');
  });

  test('approves pending user and allows login afterwards', async () => {
    const { registerRes, user } = await createPendingUser();

    expect(registerRes.statusCode).toBe(201);

    const userResult = await db.query('SELECT id, is_approved FROM users WHERE email = $1', [user.email]);
    expect(userResult.rows.length).toBe(1);

    const userId = userResult.rows[0].id;
    createdUserIds.push(userId);
    expect(userResult.rows[0].is_approved).toBe(false);

    const approvalPayload = await createApprovalRequest(userId, user);
    expect(approvalPayload?.token).toBeTruthy();

    const approveRes = await request(app)
      .get(`/api/admin/users/approve?token=${encodeURIComponent(approvalPayload.token)}`);
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.text).toContain('Registration Approval');

    const loginRes = await request(app)
      .post('/api/login')
      .send({ email: user.email, password: user.password });

    expect(loginRes.statusCode).toBe(200);
    expect(typeof loginRes.body.token).toBe('string');
    expect(loginRes.body.token.length).toBeGreaterThan(10);

    const finalState = await db.query('SELECT is_approved FROM users WHERE id = $1', [userId]);
    expect(finalState.rows.length).toBe(1);
    expect(finalState.rows[0].is_approved).toBe(true);
  });

  test('returns "link replaced" when an older token is presented', async () => {
    const originalCooldown = process.env.REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES;
    process.env.REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES = '0';

    try {
      const { user } = await createPendingUser();
      const userResult = await db.query('SELECT id, is_approved FROM users WHERE email = $1', [user.email]);
      expect(userResult.rows.length).toBe(1);

      const userId = userResult.rows[0].id;
      createdUserIds.push(userId);
      expect(userResult.rows[0].is_approved).toBe(false);

      const firstRequest = await createApprovalRequest(userId, user);
      expect(firstRequest?.token).toBeTruthy();

      await db.query(
        'UPDATE registration_approval_tokens SET last_notified_at = NOW() - INTERVAL \'1 day\' WHERE user_id = $1',
        [userId]
      );

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const secondRequest = await createApprovalRequest(userId, user);
      expect(secondRequest?.token).toBeTruthy();
      expect(secondRequest.token).not.toBe(firstRequest.token);

      const staleApproveRes = await request(app)
        .get(`/api/admin/users/approve?token=${encodeURIComponent(firstRequest.token)}`);
      expect(staleApproveRes.statusCode).toBe(400);
      expect(staleApproveRes.text).toContain('Registration Approval');
      expect(staleApproveRes.text).toContain('A newer approval link has been issued');

      const approveRes = await request(app)
        .get(`/api/admin/users/approve?token=${encodeURIComponent(secondRequest.token)}`);
      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.text).toContain('Registration approved for user');
    } finally {
      if (originalCooldown === undefined) {
        delete process.env.REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES;
      } else {
        process.env.REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES = originalCooldown;
      }
    }
  });

  test('does not resend approval email within cooldown window', async () => {
    const { registerRes, user } = await createPendingUser();

    expect(registerRes.statusCode).toBe(201);

    const userResult = await db.query('SELECT id FROM users WHERE email = $1', [user.email]);
    expect(userResult.rows.length).toBe(1);
    const userId = userResult.rows[0].id;
    createdUserIds.push(userId);

    await createApprovalRequest(userId, user);
    await createApprovalRequest(userId, user);

    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });

  test('blocks additional registrations when approval queue is at capacity', async () => {
    const originalQueueLimit = process.env.REGISTRATION_APPROVAL_MAX_PENDING;
    process.env.REGISTRATION_APPROVAL_MAX_PENDING = '1';

    try {
      const first = await createPendingUser();
      const second = await createPendingUser();

      expect(first.registerRes.statusCode).toBe(201);
      expect(first.registerRes.body.requiresApproval).toBe(true);

      const userResult = await db.query('SELECT id FROM users WHERE email = $1', [first.user.email]);
      expect(userResult.rows.length).toBe(1);
      createdUserIds.push(userResult.rows[0].id);

      expect(second.registerRes.statusCode).toBe(429);
      expect(second.registerRes.body.code).toBe('REGISTRATION_QUEUE_FULL');
      expect(second.registerRes.body.message).toMatch(/already 1 registration/);

      const secondUserResult = await db.query('SELECT id FROM users WHERE email = $1', [second.user.email]);
      expect(secondUserResult.rows.length).toBe(0);
    } finally {
      if (originalQueueLimit === undefined) {
        delete process.env.REGISTRATION_APPROVAL_MAX_PENDING;
      } else {
        process.env.REGISTRATION_APPROVAL_MAX_PENDING = originalQueueLimit;
      }
    }
  });
});

describe('Signup context in the approval email', () => {
  const createdUserIds = [];
  const sendEmailSpy = jest.spyOn(emailVerificationService, 'sendEmail');
  const originalMaxPending = process.env.REGISTRATION_APPROVAL_MAX_PENDING;

  // Fixture in iptoasn combined format; loaded in place of the downloaded file.
  const ASN_FIXTURE = [
    '80.128.0.0\t80.159.255.255\t3320\tDE\tDTAG Internet service provider operations',
    '88.198.0.0\t88.198.255.255\t24940\tDE\tHETZNER-AS',
    '2a01:4f8::\t2a01:4f8:ffff:ffff:ffff:ffff:ffff:ffff\t24940\tDE\tHETZNER-AS'
  ].join('\n');
  const TOR_FIXTURE = '88.198.200.200\n';

  const pendingRowFor = async (userId) => {
    const res = await db.query(
      `SELECT status, host(signup_ip) AS signup_ip, signup_user_agent, signup_asn
       FROM registration_approval_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    return res.rows[0] || null;
  };

  const userIdFor = async (email) => {
    const res = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    const id = res.rows[0]?.id;
    if (id) createdUserIds.push(id);
    return id;
  };

  const lastEmailText = () => {
    const call = sendEmailSpy.mock.calls[sendEmailSpy.mock.calls.length - 1];
    return call ? call[0].text : '';
  };

  beforeAll(() => {
    ipIntelService.loadFromStrings({ asnTsv: ASN_FIXTURE, torText: TOR_FIXTURE });
  });

  beforeEach(async () => {
    sendEmailSpy.mockClear();
    process.env.REGISTRATION_APPROVAL_MAX_PENDING = '0';
    await db.query(`DELETE FROM registration_approval_tokens WHERE status = 'pending'`);
  });

  afterAll(async () => {
    ipIntelService.loadFromStrings({ asnTsv: '', torText: '' });
    if (originalMaxPending === undefined) {
      delete process.env.REGISTRATION_APPROVAL_MAX_PENDING;
    } else {
      process.env.REGISTRATION_APPROVAL_MAX_PENDING = originalMaxPending;
    }
    if (createdUserIds.length) {
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
    }
  });

  test('stores ip and user agent on the pending row and puts them in the email', async () => {
    const { registerRes, user } = await createPendingUser({ ip: '80.130.4.9', userAgent: 'TestBrowser/1.0' });
    expect(registerRes.statusCode).toBe(201);
    const userId = await userIdFor(user.email);

    const row = await pendingRowFor(userId);
    expect(row.status).toBe('pending');
    expect(row.signup_ip).toBe('80.130.4.9');
    expect(row.signup_user_agent).toBe('TestBrowser/1.0');
    expect(row.signup_asn).toBe(3320);

    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const text = lastEmailText();
    expect(text).toContain('80.130.4.9');
    expect(text).toContain('TestBrowser/1.0');
    expect(text).toContain('AS3320');
    expect(text).toContain('DTAG');
    expect(text).toContain('DE');
    expect(text).not.toMatch(/hosting/i);
    expect(text).not.toMatch(/tor exit/i);
  });

  test('tolerates a proxy that forwards ip:port', async () => {
    const v4 = await createPendingUser({ ip: '80.130.4.9:54321', userAgent: 'T' });
    const v4Id = await userIdFor(v4.user.email);
    expect((await pendingRowFor(v4Id)).signup_ip).toBe('80.130.4.9');
    expect((await pendingRowFor(v4Id)).signup_asn).toBe(3320);

    const v6 = await createPendingUser({ ip: '[2a01:4f8::1]:443', userAgent: 'T' });
    const v6Id = await userIdFor(v6.user.email);
    expect((await pendingRowFor(v6Id)).signup_ip).toBe('2a01:4f8::1');
    expect((await pendingRowFor(v6Id)).signup_asn).toBe(24940);
  });

  test('flags hosting networks and tor exits', async () => {
    const hosting = await createPendingUser({ ip: '88.198.10.10', userAgent: 'curl/8.0' });
    await userIdFor(hosting.user.email);
    expect(lastEmailText()).toMatch(/hosting/i);
    expect(lastEmailText()).not.toMatch(/tor exit/i);

    const tor = await createPendingUser({ ip: '88.198.200.200', userAgent: 'Mozilla/5.0' });
    await userIdFor(tor.user.email);
    expect(lastEmailText()).toMatch(/tor exit/i);
  });

  test('counts other pending signups from the same network in the last 24h', async () => {
    const first = await createPendingUser({ ip: '88.198.1.1', userAgent: 'A' });
    await userIdFor(first.user.email);
    expect(lastEmailText()).toMatch(/0 other signups? from this network/i);

    const second = await createPendingUser({ ip: '88.198.2.2', userAgent: 'B' });
    await userIdFor(second.user.email);
    expect(lastEmailText()).toMatch(/1 other signup from this network/i);
  });

  test('says so when the address is not in the lookup data', async () => {
    const { user } = await createPendingUser({ ip: '9.9.9.9', userAgent: 'X' });
    const userId = await userIdFor(user.email);
    expect((await pendingRowFor(userId)).signup_asn).toBeNull();
    expect(lastEmailText()).toContain('9.9.9.9');
    expect(lastEmailText()).toMatch(/network:.*unknown/i);
  });

  test('approval clears the signup context', async () => {
    const { user } = await createPendingUser({ ip: '80.130.4.9', userAgent: 'TestBrowser/1.0' });
    const userId = await userIdFor(user.email);
    const tokenRow = await db.query('SELECT token FROM registration_approval_tokens WHERE user_id = $1', [userId]);

    const approveRes = await request(app)
      .get(`/api/admin/users/approve?token=${encodeURIComponent(tokenRow.rows[0].token)}`);
    expect(approveRes.statusCode).toBe(200);

    const row = await pendingRowFor(userId);
    expect(row.status).toBe('approved');
    expect(row.signup_ip).toBeNull();
    expect(row.signup_user_agent).toBeNull();
    expect(row.signup_asn).toBeNull();
  });

  test('the email carries a reject link; GET only confirms, POST deletes the account', async () => {
    const { user } = await createPendingUser({ ip: '88.198.10.10', userAgent: 'curl/8.0' });
    const userId = await userIdFor(user.email);
    const tokenRow = await db.query('SELECT token FROM registration_approval_tokens WHERE user_id = $1', [userId]);
    const token = tokenRow.rows[0].token;

    expect(lastEmailText()).toContain('/api/admin/users/reject?token=');

    const confirmRes = await request(app)
      .get(`/api/admin/users/reject?token=${encodeURIComponent(token)}`);
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.text).toMatch(/<form[^>]*method="post"/i);
    expect(confirmRes.text).toContain(user.username);
    const stillThere = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
    expect(stillThere.rows.length).toBe(1);

    const rejectRes = await request(app)
      .post('/api/admin/users/reject')
      .type('form')
      .send({ token });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.text).toMatch(/rejected/i);

    const gone = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
    expect(gone.rows.length).toBe(0);
    const tokensGone = await db.query('SELECT id FROM registration_approval_tokens WHERE user_id = $1', [userId]);
    expect(tokensGone.rows.length).toBe(0);

    const approveAfter = await request(app)
      .get(`/api/admin/users/approve?token=${encodeURIComponent(token)}`);
    expect(approveAfter.statusCode).toBe(400);

    const loginRes = await request(app)
      .post('/api/login')
      .send({ email: user.email, password: user.password });
    expect(loginRes.statusCode).not.toBe(200);
  });

  test('rejecting an already approved account is refused', async () => {
    const { user } = await createPendingUser({ ip: '80.130.4.9', userAgent: 'T' });
    const userId = await userIdFor(user.email);
    const tokenRow = await db.query('SELECT token FROM registration_approval_tokens WHERE user_id = $1', [userId]);
    const token = tokenRow.rows[0].token;

    await request(app).get(`/api/admin/users/approve?token=${encodeURIComponent(token)}`).expect(200);

    const rejectRes = await request(app)
      .post('/api/admin/users/reject')
      .type('form')
      .send({ token });
    expect(rejectRes.statusCode).toBe(400);
    expect(rejectRes.text).toMatch(/already been approved/i);

    const stillThere = await db.query('SELECT id, is_approved FROM users WHERE id = $1', [userId]);
    expect(stillThere.rows.length).toBe(1);
    expect(stillThere.rows[0].is_approved).toBe(true);
  });

  test('scrub clears context on rows that expired without a decision', async () => {
    const { user } = await createPendingUser({ ip: '80.130.4.9', userAgent: 'T' });
    const userId = await userIdFor(user.email);
    await db.query(
      `UPDATE registration_approval_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1`,
      [userId]
    );

    const { scrubStaleSignupContext } = require('../src/services/registrationApprovalService');
    await scrubStaleSignupContext();

    const row = await pendingRowFor(userId);
    expect(row.signup_ip).toBeNull();
    expect(row.signup_user_agent).toBeNull();
    expect(row.signup_asn).toBeNull();
  });
});
