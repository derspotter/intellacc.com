const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const PASSWORD_RESET_SECRET = process.env.PASSWORD_RESET_SECRET || 'dev-password-reset-secret-change-in-production';

const createUser = async () => {
  const unique = Date.now();
  const email = `reset_${unique}@example.com`;
  const username = `reset_${unique}`;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  const userRow = await db.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);

  return {
    id: userRow.rows[0].id,
    email,
    username,
    password,
    passwordHash: userRow.rows[0].password_hash,
    token: loginRes.body.token
  };
};

const createResetToken = async (userId, email) => {
  const token = jwt.sign(
    { userId, email, purpose: 'password_reset' },
    PASSWORD_RESET_SECRET,
    { expiresIn: '1h' }
  );
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  const insert = await db.query(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
    [userId, tokenHash, expiresAt]
  );

  return { token, tokenId: insert.rows[0].id };
};

const insertMlsData = async (userId, devicePublicId, otherUserId) => {
  const groupId = `group_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const dmGroupId = `dm_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  await db.query(
    'INSERT INTO mls_groups (group_id, name, created_by) VALUES ($1, $2, $3)',
    [groupId, 'Reset Test Group', userId]
  );
  await db.query(
    'INSERT INTO mls_group_members (group_id, user_id) VALUES ($1, $2)',
    [groupId, userId]
  );
  await db.query(
    'INSERT INTO mls_key_packages (user_id, device_id, package_data, hash) VALUES ($1, $2, $3, $4)',
    [userId, 'default', Buffer.from('kp'), `hash_${Date.now()}`]
  );
  await db.query(
    'INSERT INTO mls_welcome_messages (group_id, receiver_id, sender_id, data) VALUES ($1, $2, $3, $4)',
    [groupId, userId, otherUserId, Buffer.from('welcome')]
  );
  await db.query(
    'INSERT INTO mls_group_messages (group_id, sender_id, epoch, content_type, data) VALUES ($1, $2, $3, $4, $5)',
    [groupId, userId, 1, 'application', Buffer.from('message')]
  );

  await db.query(
    'INSERT INTO mls_groups (group_id, name, created_by) VALUES ($1, $2, $3)',
    [dmGroupId, 'Reset DM Group', userId]
  );

  const userA = Math.min(userId, otherUserId);
  const userB = Math.max(userId, otherUserId);
  await db.query(
    'INSERT INTO mls_direct_messages (group_id, user_a_id, user_b_id, created_by) VALUES ($1, $2, $3, $4)',
    [dmGroupId, userA, userB, userId]
  );

  return { groupId, dmGroupId };
};

describe('Password reset flow', () => {
  let users = [];
  let mlsGroups = [];

  afterAll(async () => {
    if (mlsGroups.length > 0) {
      await db.query('DELETE FROM mls_groups WHERE group_id = ANY($1)', [mlsGroups]);
    }

    for (const user of users) {
      await db.query('DELETE FROM password_reset_requests WHERE user_id = $1', [user.id]);
      await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
      await db.query('DELETE FROM user_master_keys WHERE user_id = $1', [user.id]);
      await db.query('DELETE FROM user_devices WHERE user_id = $1', [user.id]);
      await db.query('DELETE FROM users WHERE id = $1', [user.id]);
    }
  });

  test('forgot password returns success for unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: `unknown_${Date.now()}@example.com` });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('forgot password creates a reset token for existing user', async () => {
    const user = await createUser();
    users.push(user);

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: user.email });

    expect(res.statusCode).toBe(200);

    const tokenRows = await db.query(
      'SELECT id, used_at FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [user.id]
    );

    expect(tokenRows.rows.length).toBe(1);
    expect(tokenRows.rows[0].used_at).toBeNull();
  });

  test('forgot password does not send duplicate email within cooldown', async () => {
    const user = await createUser();
    users.push(user);

    const firstRes = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: user.email });

    expect(firstRes.statusCode).toBe(200);

    const firstTokenRows = await db.query(
      'SELECT id, created_at FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC',
      [user.id]
    );

    expect(firstTokenRows.rows.length).toBe(1);
    const firstCreatedAt = new Date(firstTokenRows.rows[0].created_at).getTime();

    const secondRes = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: user.email });

    expect(secondRes.statusCode).toBe(200);

    const secondTokenRows = await db.query(
      'SELECT id, created_at FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC',
      [user.id]
    );

    expect(secondTokenRows.rows.length).toBe(1);
    expect(new Date(secondTokenRows.rows[0].created_at).getTime()).toBe(firstCreatedAt);
  });

  test('immediate reset updates password, clears MLS data, and revokes old JWT', async () => {
    const user = await createUser();
    users.push(user);

    const devicePublicId = crypto.randomUUID();
    await db.query(
      'INSERT INTO user_devices (user_id, device_public_id, name, is_primary) VALUES ($1, $2, $3, $4)',
      [user.id, devicePublicId, 'Reset Device', true]
    );

    const otherUser = await createUser();
    users.push(otherUser);

    await db.query(
      'INSERT INTO user_master_keys (user_id, wrapped_key, salt, iv) VALUES ($1, $2, $3, $4)',
      [user.id, 'wrapped', 'salt', 'iv']
    );

    const groups = await insertMlsData(user.id, devicePublicId, otherUser.id);
    mlsGroups.push(groups.groupId, groups.dmGroupId);

    const { token } = await createResetToken(user.id, user.email);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const resetRes = await request(app)
      .post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        token,
        newPassword: 'newpass123',
        acknowledged: true,
        device_public_id: devicePublicId
      });

    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.body.status).toBe('completed');

    const reuseRes = await request(app)
      .post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        token,
        newPassword: 'anotherpass123',
        acknowledged: true,
        device_public_id: devicePublicId
      });

    expect(reuseRes.statusCode).toBe(400);

    const userRow = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    const passwordMatches = await bcrypt.compare('newpass123', userRow.rows[0].password_hash);
    expect(passwordMatches).toBe(true);

    const masterKeys = await db.query('SELECT 1 FROM user_master_keys WHERE user_id = $1', [user.id]);
    expect(masterKeys.rows.length).toBe(0);

    const mlsKeyPackages = await db.query('SELECT id FROM mls_key_packages WHERE user_id = $1', [user.id]);
    expect(mlsKeyPackages.rows.length).toBe(0);

    const groupMembers = await db.query('SELECT 1 FROM mls_group_members WHERE user_id = $1', [user.id]);
    expect(groupMembers.rows.length).toBe(0);

    const groupMessages = await db.query('SELECT 1 FROM mls_group_messages WHERE sender_id = $1', [user.id]);
    expect(groupMessages.rows.length).toBe(0);

    const welcomeMessages = await db.query(
      'SELECT 1 FROM mls_welcome_messages WHERE receiver_id = $1 OR sender_id = $1',
      [user.id]
    );
    expect(welcomeMessages.rows.length).toBe(0);

    const directMessages = await db.query(
      'SELECT 1 FROM mls_direct_messages WHERE user_a_id = $1 OR user_b_id = $1',
      [user.id]
    );
    expect(directMessages.rows.length).toBe(0);

    const tokenRows = await db.query(
      'SELECT used_at FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [user.id]
    );
    expect(tokenRows.rows[0].used_at).not.toBeNull();

    const meRes = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${user.token}`);

    expect(meRes.statusCode).toBe(401);
  });

  test('email-only reset schedules a pending request and can be canceled', async () => {
    const user = await createUser();
    users.push(user);

    const { token } = await createResetToken(user.id, user.email);

    const resetRes = await request(app)
      .post('/api/auth/reset-password')
      .send({
        token,
        newPassword: 'pendingpass123',
        acknowledged: true
      });

    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.body.status).toBe('pending');
    expect(resetRes.body.executeAfter).toBeDefined();

    const userRow = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    const stillOldPassword = await bcrypt.compare(user.password, userRow.rows[0].password_hash);
    expect(stillOldPassword).toBe(true);

    const requestRow = await db.query(
      "SELECT status, new_password_hash FROM password_reset_requests WHERE user_id = $1 AND status = 'pending'",
      [user.id]
    );

    expect(requestRow.rows.length).toBe(1);
    const pendingMatches = await bcrypt.compare('pendingpass123', requestRow.rows[0].new_password_hash);
    expect(pendingMatches).toBe(true);

    const cancelRes = await request(app)
      .post('/api/auth/reset-password/cancel')
      .set('Authorization', `Bearer ${user.token}`);

    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.body.cancelled).toBe(true);

    const cancelledRow = await db.query(
      "SELECT status FROM password_reset_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );

    expect(cancelledRow.rows[0].status).toBe('cancelled');
  });

  test('reset requires acknowledgment', async () => {
    const user = await createUser();
    users.push(user);

    const { token } = await createResetToken(user.id, user.email);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({
        token,
        newPassword: 'ackpass123',
        acknowledged: false
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Acknowledgment/i);
  });
});
