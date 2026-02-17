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

jest.setTimeout(30000);

const createPendingUser = async () => {
  const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const username = `pending_${unique}`;
  const email = `${username}@example.com`;
  const password = 'testpass123';

  const registerRes = await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

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
  });

  beforeEach(() => {
    sendEmailSpy.mockClear();
  });

  afterAll(async () => {
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
});
