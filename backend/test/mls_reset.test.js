const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(20000);

// Self-service E2EE reset (POST /api/mls/reset): password-confirmed wipe of
// the caller's MLS state. DM groups are deleted for both sides; shared groups
// are only left; the peer's own devices/keys must survive untouched.

describe('POST /api/mls/reset', () => {
  const ts = Date.now();
  const password = 'testpass123';
  let userAId;
  let userBId;
  let tokenA;
  let deviceAId;
  let deviceBId;
  let dmGroupId;
  const sharedGroupId = `grp_reset_test_${ts}`;

  const createUser = async (tag) => {
    const hash = await bcrypt.hash(password, 10);
    const res = await db.query(
      `INSERT INTO users (email, username, password_hash, verification_tier, created_at, updated_at)
       VALUES ($1, $2, $3, 1, NOW(), NOW()) RETURNING id`,
      [`mls_reset_${tag}_${ts}@example.com`, `mls_reset_${tag}_${ts}`, hash]
    );
    return res.rows[0].id;
  };

  const createDevice = async (userId) => {
    const res = await db.query(
      `INSERT INTO user_devices (user_id, device_public_id, name, last_verified_at)
       VALUES ($1, gen_random_uuid(), 'test-device', NOW()) RETURNING id`,
      [userId]
    );
    return res.rows[0].id;
  };

  const count = async (sql, params) => Number((await db.query(sql, params)).rows[0].count);

  beforeAll(async () => {
    userAId = await createUser('a');
    userBId = await createUser('b');
    deviceAId = await createDevice(userAId);
    deviceBId = await createDevice(userBId);

    for (const uid of [userAId, userBId]) {
      await db.query(
        `INSERT INTO user_master_keys (user_id, wrapped_key, salt, iv) VALUES ($1, 'wk', 's', 'iv')`,
        [uid]
      );
      await db.query(
        `INSERT INTO mls_key_packages (user_id, device_id, package_data, hash)
         VALUES ($1, 'default', '\\x00', $2)`,
        [uid, `hash_${uid}_${ts}`]
      );
    }

    const [minId, maxId] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
    dmGroupId = `dm_${minId}_${maxId}`;
    await db.query(`INSERT INTO mls_groups (group_id, created_by) VALUES ($1, $2)`, [dmGroupId, userAId]);
    await db.query(
      `INSERT INTO mls_direct_messages (group_id, user_a_id, user_b_id, created_by) VALUES ($1, $2, $3, $2)`,
      [dmGroupId, minId, maxId]
    );
    await db.query(`INSERT INTO mls_group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)`, [dmGroupId, userAId, userBId]);

    const queueRes = await db.query(
      `INSERT INTO mls_relay_queue (group_id, sender_device_id, message_type, data)
       VALUES ($1, $2, 'application', '\\x00') RETURNING id`,
      [dmGroupId, deviceAId]
    );
    await db.query(
      `INSERT INTO mls_relay_recipients (queue_id, recipient_device_id) VALUES ($1, $2)`,
      [queueRes.rows[0].id, deviceBId]
    );

    await db.query(`INSERT INTO mls_groups (group_id, name, created_by) VALUES ($1, 'shared', $2)`, [sharedGroupId, userBId]);
    await db.query(`INSERT INTO mls_group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)`, [sharedGroupId, userAId, userBId]);

    const login = await request(app)
      .post('/api/login')
      .send({ email: `mls_reset_a_${ts}@example.com`, password });
    tokenA = login.body.token;
    expect(tokenA).toBeDefined();
  });

  afterAll(async () => {
    await db.query('DELETE FROM mls_groups WHERE group_id IN ($1, $2)', [dmGroupId, sharedGroupId]);
    await db.query('DELETE FROM users WHERE id IN ($1, $2)', [userAId, userBId]);
  });

  test('rejects a wrong password without touching state', async () => {
    const res = await request(app)
      .post('/api/mls/reset')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ password: 'wrong-password' });

    // 403, not 401: an authenticated 401 triggers the client's session-expired
    // logout and would mask the "incorrect password" error.
    expect(res.statusCode).toBe(403);
    expect(await count('SELECT COUNT(*) FROM user_devices WHERE user_id = $1', [userAId])).toBe(1);
    expect(await count('SELECT COUNT(*) FROM mls_groups WHERE group_id = $1', [dmGroupId])).toBe(1);
  });

  test('rejects a missing password', async () => {
    const res = await request(app)
      .post('/api/mls/reset')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(res.statusCode).toBe(400);
  });

  test('wipes the caller, deletes DMs, leaves shared groups, spares the peer', async () => {
    const res = await request(app)
      .post('/api/mls/reset')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ password });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dmsDeleted).toBe(1);

    // Caller's E2EE state is gone.
    expect(await count('SELECT COUNT(*) FROM user_devices WHERE user_id = $1', [userAId])).toBe(0);
    expect(await count('SELECT COUNT(*) FROM user_master_keys WHERE user_id = $1', [userAId])).toBe(0);
    expect(await count('SELECT COUNT(*) FROM mls_key_packages WHERE user_id = $1', [userAId])).toBe(0);
    expect(await count('SELECT COUNT(*) FROM mls_group_members WHERE user_id = $1', [userAId])).toBe(0);

    // The DM (group, mapping, relay traffic) is fully deleted.
    expect(await count('SELECT COUNT(*) FROM mls_groups WHERE group_id = $1', [dmGroupId])).toBe(0);
    expect(await count('SELECT COUNT(*) FROM mls_direct_messages WHERE group_id = $1', [dmGroupId])).toBe(0);
    expect(await count('SELECT COUNT(*) FROM mls_relay_queue WHERE group_id = $1', [dmGroupId])).toBe(0);

    // The shared group survives with the peer still in it.
    expect(await count('SELECT COUNT(*) FROM mls_groups WHERE group_id = $1', [sharedGroupId])).toBe(1);
    expect(await count('SELECT COUNT(*) FROM mls_group_members WHERE group_id = $1 AND user_id = $2', [sharedGroupId, userBId])).toBe(1);

    // The peer's own E2EE state is untouched.
    expect(await count('SELECT COUNT(*) FROM user_devices WHERE user_id = $1', [userBId])).toBe(1);
    expect(await count('SELECT COUNT(*) FROM user_master_keys WHERE user_id = $1', [userBId])).toBe(1);
    expect(await count('SELECT COUNT(*) FROM mls_key_packages WHERE user_id = $1', [userBId])).toBe(1);
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/api/mls/reset').send({ password });
    expect(res.statusCode).toBe(401);
  });
});
