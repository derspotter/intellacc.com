// Database-level contract for gmail plus-address account identity:
// the SQL function and the unique index that make
// "one mailbox, one live account" an invariant rather than a convention.
//
// See migrations/20260917_add_email_identity_key.sql.

const db = require('../src/db');

jest.setTimeout(30000);

const unique = () => `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const createdUserIds = [];

const insertUser = async (email, { client = db, deletedAt = null } = {}) => {
  const username = `eid_${unique()}`;
  const result = await client.query(
    `INSERT INTO users (username, email, password_hash, deleted_at, created_at, updated_at)
     VALUES ($1, $2, 'x', $3, NOW(), NOW())
     RETURNING id`,
    [username, email, deletedAt]
  );
  const id = result.rows[0].id;
  createdUserIds.push(id);
  return id;
};

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
  }
});

describe('email_identity_key()', () => {
  // Every case here is also a statement about what we deliberately do NOT do:
  // no dot stripping, no googlemail rewriting, no touching other providers.
  const cases = [
    ['user+tag@gmail.com', 'user@gmail.com'],
    ['user+one+two@gmail.com', 'user@gmail.com'],
    ['  User+Tag@GMAIL.com  ', 'user@gmail.com'],
    ['user@gmail.com', 'user@gmail.com'],
    ['first.last+tag@gmail.com', 'first.last@gmail.com'],
    ['first.last@gmail.com', 'first.last@gmail.com'],
    ['user+tag@googlemail.com', 'user+tag@googlemail.com'],
    ['user+tag@posteo.de', 'user+tag@posteo.de'],
    ['user+tag@gmail.com.evil.example', 'user+tag@gmail.com.evil.example'],
    ['user+tag@notgmail.com', 'user+tag@notgmail.com'],
    ['+tag@gmail.com', '+tag@gmail.com'],
    ['a@b@gmail.com', 'a@b@gmail.com'],
    ['not-an-email', 'not-an-email'],
    ['social_abc@social.intellacc.local', 'social_abc@social.intellacc.local'],
    ['', '']
  ];

  test.each(cases)('SQL folds %p to %p', async (input, expected) => {
    const result = await db.query('SELECT email_identity_key($1) AS key', [input]);
    expect(result.rows[0].key).toBe(expected);
  });

  test('SQL returns NULL for NULL input', async () => {
    const result = await db.query('SELECT email_identity_key(NULL) AS key');
    expect(result.rows[0].key).toBeNull();
  });

  test('the function is IMMUTABLE (required by the expression index)', async () => {
    const result = await db.query(
      `SELECT provolatile FROM pg_proc WHERE oid = 'public.email_identity_key(text)'::regprocedure`
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].provolatile).toBe('i');
  });
});

describe('unique index on the active mailbox identity', () => {
  test('a gmail alias of a live account cannot be inserted', async () => {
    const base = `eid_${unique()}`;
    await insertUser(`${base}@gmail.com`);

    await expect(insertUser(`${base}+newsletter@gmail.com`)).rejects.toMatchObject({
      code: '23505'
    });
  });

  test('two aliases of the same gmail mailbox collide with each other', async () => {
    const base = `eid_${unique()}`;
    await insertUser(`${base}+one@gmail.com`);

    await expect(insertUser(`${base}+two@gmail.com`)).rejects.toMatchObject({
      code: '23505'
    });
  });

  test('plus-addresses at other providers stay separate accounts', async () => {
    const base = `eid_${unique()}`;
    const plain = await insertUser(`${base}@posteo.de`);
    const tagged = await insertUser(`${base}+tag@posteo.de`);
    const googlemail = await insertUser(`${base}+tag@googlemail.com`);

    expect(new Set([plain, tagged, googlemail]).size).toBe(3);
  });

  test('dotted gmail addresses stay separate accounts (no dot stripping)', async () => {
    const base = `eid${unique()}`;
    const dotted = await insertUser(`${base.slice(0, 6)}.${base.slice(6)}@gmail.com`);
    const undotted = await insertUser(`${base}@gmail.com`);

    expect(dotted).not.toBe(undotted);
  });

  test('a soft-deleted account no longer holds its mailbox identity', async () => {
    const base = `eid_${unique()}`;
    const deletedId = await insertUser(`${base}@gmail.com`, { deletedAt: new Date() });

    // Same mailbox, different raw address: only the identity index could
    // object, and it must not, because the old row is gone from the product.
    const liveId = await insertUser(`${base}+again@gmail.com`);

    expect(liveId).not.toBe(deletedId);
  });

  test('deleting an account frees its identity for re-registration', async () => {
    const base = `eid_${unique()}`;
    const firstId = await insertUser(`${base}@gmail.com`);
    await db.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [firstId]);

    const secondId = await insertUser(`${base}+reused@gmail.com`);
    expect(secondId).not.toBe(firstId);
  });
});

describe('the lookup every entry point shares', () => {
  // Login, password reset and the WebAuthn credential lookup all run this
  // shape. The WebAuthn endpoint cannot be asserted end to end (see the note
  // in email_identity_accounts.test.js), so its resolution is pinned here.
  const lookup = (identifier) =>
    db.query(
      `SELECT id FROM users
       WHERE deleted_at IS NULL
         AND email_identity_key(email) = email_identity_key($1)
       ORDER BY (LOWER(BTRIM(email)) = LOWER(BTRIM($1))) DESC, id ASC
       LIMIT 1`,
      [identifier]
    );

  test('an alias resolves to the account registered without it', async () => {
    const base = `eid_${unique()}`;
    const id = await insertUser(`${base}@gmail.com`);

    const result = await lookup(` ${base.toUpperCase()}+KEY@Gmail.com `);
    expect(result.rows[0].id).toBe(id);
  });

  test('a soft-deleted account resolves to nobody', async () => {
    const base = `eid_${unique()}`;
    await insertUser(`${base}@gmail.com`, { deletedAt: new Date() });

    const result = await lookup(`${base}+key@gmail.com`);
    expect(result.rows).toHaveLength(0);
  });

  test('a non-gmail alias resolves to nobody', async () => {
    const base = `eid_${unique()}`;
    await insertUser(`${base}@posteo.de`);

    const result = await lookup(`${base}+tag@posteo.de`);
    expect(result.rows).toHaveLength(0);
  });

  test('migration rejects existing collisions without changing either account', async () => {
    const fs = require('fs');
    const path = require('path');
    const migration = fs.readFileSync(
      path.join(__dirname, '../migrations/20260917_add_email_identity_key.sql'), 'utf8'
    ).replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '');
    const client = await db.getPool().connect();
    const schema = `email_collision_${unique()}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query('CREATE TABLE users (id INTEGER, email TEXT, deleted_at TIMESTAMPTZ)');
      await client.query(`INSERT INTO users VALUES
        (1, 'collision@gmail.com', NULL), (2, 'collision+tag@gmail.com', NULL)`);
      await client.query('SAVEPOINT before_migration');
      await expect(client.query(migration)).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK TO SAVEPOINT before_migration');
      const rows = await client.query('SELECT id, email FROM users ORDER BY id');
      expect(rows.rows).toEqual([
        { id: 1, email: 'collision@gmail.com' },
        { id: 2, email: 'collision+tag@gmail.com' }
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('the rolled-back transaction left the unique index in place', async () => {
    const result = await db.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'users' AND indexname = 'uniq_users_email_identity_active'`
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toContain('deleted_at IS NULL');
  });
});

describe('concurrent signups for one gmail mailbox', () => {
  // The controller's SELECT-then-INSERT check cannot see an uncommitted row,
  // so two simultaneous signups can both pass it. The index is what actually
  // decides, and this is the race it has to survive.
  test('exactly one of two racing inserts wins', async () => {
    const base = `eid_${unique()}`;
    const pool = db.getPool();
    const first = await pool.connect();
    const second = await pool.connect();

    try {
      await first.query('BEGIN');
      await second.query('BEGIN');

      await insertUser(`${base}+first@gmail.com`, { client: first });

      // Blocks on the first transaction's index entry until it commits.
      const racing = insertUser(`${base}+second@gmail.com`, { client: second });
      const settled = racing.then(
        () => ({ status: 'fulfilled' }),
        (error) => ({ status: 'rejected', error })
      );

      await first.query('COMMIT');

      const outcome = await settled;
      expect(outcome.status).toBe('rejected');
      expect(outcome.error.code).toBe('23505');

      await second.query('ROLLBACK');

      const survivors = await db.query(
        `SELECT count(*)::int AS count FROM users
         WHERE deleted_at IS NULL AND email_identity_key(email) = $1`,
        [`${base}@gmail.com`]
      );
      expect(survivors.rows[0].count).toBe(1);
    } finally {
      first.release();
      second.release();
    }
  });
});
