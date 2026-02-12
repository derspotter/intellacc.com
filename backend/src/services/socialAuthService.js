const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const USERNAME_MAX_LEN = 50;

const sanitizeUsername = (value) => {
  const raw = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const trimmed = raw.slice(0, USERNAME_MAX_LEN);
  if (trimmed) return trimmed;
  return 'user';
};

const withSuffix = (base, suffix) => {
  if (!suffix) return base.slice(0, USERNAME_MAX_LEN);
  const suffixPart = `_${suffix}`;
  const maxBaseLen = Math.max(1, USERNAME_MAX_LEN - suffixPart.length);
  return `${base.slice(0, maxBaseLen)}${suffixPart}`;
};

const findUniqueUsername = async (hint) => {
  const base = sanitizeUsername(hint);

  for (let i = 0; i < 10000; i += 1) {
    const candidate = withSuffix(base, i === 0 ? '' : String(i));
    const existing = await db.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1',
      [candidate]
    );
    if (existing.rows.length === 0) {
      return candidate;
    }
  }

  throw new Error('Unable to allocate username');
};

const buildEmailBase = (provider, subject) => {
  const digest = crypto
    .createHash('sha256')
    .update(`${provider}:${subject}`)
    .digest('hex')
    .slice(0, 24);
  return `${provider}_${digest}`;
};

const findUniqueSyntheticEmail = async (provider, subject) => {
  const base = buildEmailBase(provider, subject);

  for (let i = 0; i < 10000; i += 1) {
    const local = i === 0 ? base : `${base}_${i}`;
    const email = `${local}@social.intellacc.local`;
    const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (existing.rows.length === 0) {
      return email;
    }
  }

  throw new Error('Unable to allocate synthetic email');
};

const markUserVerifiedIfSchemaAvailable = async (userId) => {
  try {
    await db.query(
      `UPDATE users
       SET verification_tier = GREATEST(COALESCE(verification_tier, 0), 1),
           email_verified_at = COALESCE(email_verified_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
  } catch (err) {
    if (err.code !== '42703') throw err;
  }

  try {
    await db.query(
      `INSERT INTO user_verifications
        (user_id, tier, verification_type, provider, status, verified_at, created_at, updated_at)
       VALUES ($1, 1, 'email', 'social_oauth', 'verified', NOW(), NOW(), NOW())
       ON CONFLICT (user_id, tier) DO UPDATE
         SET status = 'verified',
             provider = 'social_oauth',
             verified_at = COALESCE(user_verifications.verified_at, NOW()),
             updated_at = NOW()`,
      [userId]
    );
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
};

const createUserForIdentity = async ({ provider, subject, usernameHint }) => {
  const username = await findUniqueUsername(usernameHint || `${provider}_user`);
  const email = await findUniqueSyntheticEmail(provider, subject);
  const randomPassword = crypto.randomBytes(48).toString('base64url');
  const passwordHash = await bcrypt.hash(randomPassword, 10);

  const result = await db.query(
    `INSERT INTO users (username, email, password_hash, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'user', NOW(), NOW())
     RETURNING id, username, email, role, created_at, updated_at`,
    [username, email, passwordHash]
  );

  const user = result.rows[0];
  await markUserVerifiedIfSchemaAvailable(user.id);

  return user;
};

const upsertIdentity = async ({ userId, provider, subject, externalUsername, profileUrl, metadata }) => {
  const result = await db.query(
    `INSERT INTO federated_auth_identities
      (user_id, provider, subject, external_username, profile_url, metadata, last_login_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW())
     ON CONFLICT (provider, subject) DO UPDATE
       SET external_username = EXCLUDED.external_username,
           profile_url = EXCLUDED.profile_url,
           metadata = COALESCE(EXCLUDED.metadata, '{}'::jsonb),
           last_login_at = NOW(),
           updated_at = NOW()
     RETURNING id, user_id, provider, subject, external_username, profile_url, metadata, last_login_at, created_at, updated_at`,
    [
      userId,
      provider,
      subject,
      externalUsername || null,
      profileUrl || null,
      metadata || {}
    ]
  );

  return result.rows[0];
};

const findIdentityWithUser = async ({ provider, subject }) => {
  const result = await db.query(
    `SELECT
       i.id AS identity_id,
       i.user_id AS identity_user_id,
       i.provider,
       i.subject,
       i.external_username,
       i.profile_url,
       i.metadata,
       u.id AS user_id,
       u.username,
       u.email,
       u.role,
       u.deleted_at
     FROM federated_auth_identities i
     JOIN users u ON u.id = i.user_id
     WHERE i.provider = $1
       AND i.subject = $2
     LIMIT 1`,
    [provider, subject]
  );

  const row = result.rows[0];
  if (!row || row.deleted_at) return null;

  return {
    identity: {
      id: row.identity_id,
      userId: row.identity_user_id,
      provider: row.provider,
      subject: row.subject,
      externalUsername: row.external_username,
      profileUrl: row.profile_url,
      metadata: row.metadata
    },
    user: {
      id: row.user_id,
      username: row.username,
      email: row.email,
      role: row.role
    }
  };
};

const getOrCreateUserFromIdentity = async ({
  provider,
  subject,
  usernameHint,
  externalUsername,
  profileUrl,
  metadata
}) => {
  const existing = await findIdentityWithUser({ provider, subject });
  if (existing) {
    await upsertIdentity({
      userId: existing.user.id,
      provider,
      subject,
      externalUsername,
      profileUrl,
      metadata
    });
    return existing.user;
  }

  const createdUser = await createUserForIdentity({
    provider,
    subject,
    usernameHint
  });

  await upsertIdentity({
    userId: createdUser.id,
    provider,
    subject,
    externalUsername,
    profileUrl,
    metadata
  });

  return createdUser;
};

module.exports = {
  getOrCreateUserFromIdentity,
  findIdentityWithUser,
  upsertIdentity,
  findUniqueUsername,
  findUniqueSyntheticEmail
};
