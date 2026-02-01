const request = require('supertest');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async () => {
  const unique = Date.now();
  const email = `delete_${unique}@example.com`;
  const username = `delete_${unique}`;
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

const createDummyAttachment = async (userId, postId) => {
  const uploadsDir = path.join(__dirname, '..', '..', 'uploads', 'posts');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const filename = `delete_test_${crypto.randomBytes(8).toString('hex')}.png`;
  const filePath = path.join(uploadsDir, filename);
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const attachmentRes = await db.query(
    `INSERT INTO attachments
      (owner_id, scope, post_id, content_type, size, sha256, storage_path, original_name)
     VALUES ($1, 'post', $2, 'image/png', $3, $4, $5, $6)
     RETURNING id`,
    [
      userId,
      postId,
      4,
      crypto.createHash('sha256').update('delete_test').digest('hex'),
      `posts/${filename}`,
      filename
    ]
  );

  await db.query(
    'UPDATE posts SET image_attachment_id = $1 WHERE id = $2',
    [attachmentRes.rows[0].id, postId]
  );

  return { attachmentId: attachmentRes.rows[0].id, filePath };
};

describe('Account deletion', () => {
  const cleanup = [];

  afterAll(async () => {
    for (const entry of cleanup) {
      if (entry.userId) {
        await db.query('DELETE FROM users WHERE id = $1', [entry.userId]);
      }
    }
  });

  test('delete account anonymizes user and revokes access', async () => {
    const user = await createUser();
    cleanup.push({ userId: user.id });

    const postRes = await db.query(
      'INSERT INTO posts (user_id, content, image_url) VALUES ($1, $2, $3) RETURNING id',
      [user.id, 'Delete me', 'https://example.com/legacy.png']
    );
    const postId = postRes.rows[0].id;

    const devicePublicId = crypto.randomUUID();
    await db.query(
      'INSERT INTO user_devices (user_id, device_public_id, name, is_primary) VALUES ($1, $2, $3, $4)',
      [user.id, devicePublicId, 'Delete Device', true]
    );

    await db.query(
      'INSERT INTO user_master_keys (user_id, wrapped_key, salt, iv) VALUES ($1, $2, $3, $4)',
      [user.id, 'wrapped', 'salt', 'iv']
    );

    const { filePath } = await createDummyAttachment(user.id, postId);

    const deleteRes = await request(app)
      .delete('/api/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ password: user.password });

    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    const userRow = await db.query(
      'SELECT username, email, role, deleted_at, password_hash FROM users WHERE id = $1',
      [user.id]
    );
    expect(userRow.rows.length).toBe(1);
    expect(userRow.rows[0].deleted_at).toBeTruthy();
    expect(userRow.rows[0].role).toBe('deleted');
    expect(userRow.rows[0].username).toMatch(/^deleted_user_/);
    expect(userRow.rows[0].email).toMatch(/^deleted_/);
    expect(userRow.rows[0].password_hash).not.toBe(user.passwordHash);

    const devices = await db.query('SELECT 1 FROM user_devices WHERE user_id = $1', [user.id]);
    expect(devices.rows.length).toBe(0);

    const masterKeys = await db.query('SELECT 1 FROM user_master_keys WHERE user_id = $1', [user.id]);
    expect(masterKeys.rows.length).toBe(0);

    const attachments = await db.query('SELECT 1 FROM attachments WHERE owner_id = $1', [user.id]);
    expect(attachments.rows.length).toBe(0);

    const postRow = await db.query(
      'SELECT image_url, image_attachment_id FROM posts WHERE id = $1',
      [postId]
    );
    expect(postRow.rows[0].image_url).toBeNull();
    expect(postRow.rows[0].image_attachment_id).toBeNull();

    const meRes = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${user.token}`);
    expect(meRes.statusCode).toBe(403);

    await new Promise(resolve => setTimeout(resolve, 50));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });
});
