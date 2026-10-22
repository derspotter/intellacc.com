// Account-facing behaviour of gmail plus-address identity: signup, login,
// password reset and WebAuthn all have to agree on who a mailbox belongs to,
// and all of them have to ignore soft-deleted accounts.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../src/index');
const db = require('../src/db');
const passwordResetService = require('../src/services/passwordResetService');

jest.setTimeout(30000);

const PASSWORD = 'testpass123';
const DUPLICATE_MESSAGE = 'User with this email or username already exists';

const unique = () => `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const createdUserIds = [];

const register = (email, username) =>
  request(app)
    .post('/api/users/register')
    .send({ username: username || `eid_${unique()}`, email, password: PASSWORD });

const registerOk = async (email, username) => {
  const res = await register(email, username);
  expect(res.status).toBe(201);
  createdUserIds.push(res.body.user.id);
  return res.body.user;
};

const login = (email, password = PASSWORD) =>
  request(app).post('/api/login').send({ email, password });

// Login answers with a token only, so the account it resolved to is the
// userId claim inside it.
const loggedInUserId = (res) =>
  jwt.verify(res.body.token, process.env.JWT_SECRET || 'your_jwt_secret').userId;

const softDelete = (userId) =>
  db.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [userId]);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
  }
});

describe('signup', () => {
  test('stores the address trimmed and lower-cased, plus suffix intact', async () => {
    const base = `eid_${unique()}`;
    const user = await registerOk(`  ${base.toUpperCase()}+Promo@Gmail.com `);

    // The stored address must stay deliverable: the tag is how the person
    // filters their own mail, so we keep it and only fold it for comparison.
    expect(user.email).toBe(`${base.toLowerCase()}+promo@gmail.com`);

    const row = await db.query('SELECT email FROM users WHERE id = $1', [user.id]);
    expect(row.rows[0].email).toBe(`${base.toLowerCase()}+promo@gmail.com`);
  });

  test('rejects a whitespace-only email as invalid', async () => {
    const res = await register('    ');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Please provide a valid email address');
  });

  test('rejects a gmail alias of an existing account', async () => {
    const base = `eid_${unique()}`;
    await registerOk(`${base}@gmail.com`);

    const res = await register(`${base}+newsletter@gmail.com`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(DUPLICATE_MESSAGE);
  });

  test('rejects the plain address once an alias holds the account', async () => {
    const base = `eid_${unique()}`;
    await registerOk(`${base}+first@gmail.com`);

    const res = await register(`${base}@gmail.com`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(DUPLICATE_MESSAGE);
  });

  test('rejects a differently-cased duplicate', async () => {
    const base = `eid_${unique()}`;
    await registerOk(`${base}@gmail.com`);

    const res = await register(`${base.toUpperCase()}@GMAIL.COM`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(DUPLICATE_MESSAGE);
  });

  test('allows plus-addresses at other providers as separate accounts', async () => {
    const base = `eid_${unique()}`;
    const plain = await registerOk(`${base}@posteo.de`);
    const tagged = await registerOk(`${base}+tag@posteo.de`);
    const googlemail = await registerOk(`${base}+tag@googlemail.com`);

    expect(new Set([plain.id, tagged.id, googlemail.id]).size).toBe(3);
  });

  test('allows dotted gmail variants (dots are never stripped)', async () => {
    const base = `eid${unique()}`;
    const dotted = await registerOk(`${base.slice(0, 6)}.${base.slice(6)}@gmail.com`);
    const undotted = await registerOk(`${base}@gmail.com`);

    expect(dotted.id).not.toBe(undotted.id);
  });

  test('a soft-deleted account does not block its mailbox identity', async () => {
    const base = `eid_${unique()}`;
    const first = await registerOk(`${base}@gmail.com`);
    await softDelete(first.id);

    const second = await registerOk(`${base}+again@gmail.com`);
    expect(second.id).not.toBe(first.id);
  });
});

describe('login', () => {
  test('a gmail alias signs in to the account registered without it', async () => {
    const base = `eid_${unique()}`;
    const user = await registerOk(`${base}@gmail.com`);

    const res = await login(`${base}+anything@gmail.com`);
    expect(res.status).toBe(200);
    expect(loggedInUserId(res)).toBe(user.id);
  });

  test('the plain address signs in to an account registered with an alias', async () => {
    const base = `eid_${unique()}`;
    const user = await registerOk(`${base}+signup@gmail.com`);

    const res = await login(` ${base.toUpperCase()}@GMAIL.com `);
    expect(res.status).toBe(200);
    expect(loggedInUserId(res)).toBe(user.id);
  });

  test('a non-gmail alias is not the same account', async () => {
    const base = `eid_${unique()}`;
    await registerOk(`${base}@posteo.de`);

    const res = await login(`${base}+tag@posteo.de`);
    expect(res.status).toBe(401);
  });

  test('username login still works', async () => {
    const base = `eid_${unique()}`;
    const username = `eid_user_${unique()}`;
    const user = await registerOk(`${base}@gmail.com`, username);

    const res = await login(username);
    expect(res.status).toBe(200);
    expect(loggedInUserId(res)).toBe(user.id);
  });

  test('a soft-deleted account cannot be reached through an alias', async () => {
    const base = `eid_${unique()}`;
    const user = await registerOk(`${base}@gmail.com`);
    await softDelete(user.id);

    const res = await login(`${base}+tag@gmail.com`);
    expect(res.status).toBe(401);
  });
});

describe('forgot password', () => {
  let sendSpy;

  beforeEach(() => {
    sendSpy = jest
      .spyOn(passwordResetService, 'sendPasswordResetEmail')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  const forgot = (email) =>
    request(app).post('/api/auth/forgot-password').send({ email });

  test('an alias resolves to the account and mails the address on file', async () => {
    const base = `eid_${unique()}`;
    const user = await registerOk(`${base}@gmail.com`);

    const res = await forgot(`${base}+help@gmail.com`);
    expect(res.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledWith(user.id, `${base}@gmail.com`);
  });

  test('the plain address resets an alias account using its stored delivery address', async () => {
    const base = `eid_${unique()}`;
    const user = await registerOk(`${base}+signup@gmail.com`);

    const res = await forgot(` ${base.toUpperCase()}@GMAIL.COM `);
    expect(res.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledWith(user.id, `${base}+signup@gmail.com`);
  });

  test('a non-gmail alias resolves to nobody', async () => {
    const base = `eid_${unique()}`;
    await registerOk(`${base}@posteo.de`);

    const res = await forgot(`${base}+tag@posteo.de`);
    expect(res.status).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('a soft-deleted account is never mailed a reset link', async () => {
    const base = `eid_${unique()}`;
    const user = await registerOk(`${base}@gmail.com`);
    await softDelete(user.id);

    const res = await forgot(`${base}+tag@gmail.com`);
    expect(res.status).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('webauthn authentication options', () => {
  const options = (email) =>
    request(app).post('/api/webauthn/login/options').send({ email });

  const addCredential = (userId) =>
    db.query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter)
       VALUES ($1, $2, $3, 0)`,
      [userId, Buffer.from(`cred_${unique()}`), Buffer.from('test-public-key')]
    );

  // Only the deleted-account case is asserted end to end here. A live account
  // that actually owns a credential cannot be driven through this endpoint at
  // all: it hands @simplewebauthn the raw bytea Buffer from the row where the
  // library wants a base64url string, and the request 500s. That is a
  // pre-existing defect in credential serialisation, unrelated to email
  // identity, so the alias lookup itself is asserted at the query level in
  // email_identity_sql.test.js instead of being coupled to that bug.
  test('a soft-deleted account offers no credentials', async () => {
    const base = `eid_${unique()}`;
    const user = await registerOk(`${base}@gmail.com`);
    await addCredential(user.id);
    await softDelete(user.id);

    const res = await options(`${base}@gmail.com`);
    expect(res.status).toBe(200);
    expect(res.body.allowCredentials).toEqual([]);
  });

  test('an alias of a soft-deleted account offers no credentials either', async () => {
    const base = `eid_${unique()}`;
    const user = await registerOk(`${base}@gmail.com`);
    await addCredential(user.id);
    await softDelete(user.id);

    const res = await options(`${base}+key@gmail.com`);
    expect(res.status).toBe(200);
    expect(res.body.allowCredentials).toEqual([]);
  });
});
