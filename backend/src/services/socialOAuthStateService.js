const crypto = require('crypto');
const db = require('../db');
const { encryptSecret, decryptSecret } = require('./atproto/crypto');

const DEFAULT_TTL_SECONDS = 10 * 60;

const generateStateKey = () => crypto.randomBytes(24).toString('base64url');

const createOAuthState = async ({ provider, payload, ttlSeconds = DEFAULT_TTL_SECONDS }) => {
  const stateKey = generateStateKey();
  const expiresAt = new Date(Date.now() + Math.max(30, Number(ttlSeconds) || DEFAULT_TTL_SECONDS) * 1000);
  const payloadEncrypted = encryptSecret(JSON.stringify(payload || {}));

  await db.query(
    `INSERT INTO social_oauth_state
      (state_key, provider, payload_encrypted, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    [stateKey, provider, payloadEncrypted, expiresAt]
  );

  return stateKey;
};

const consumeOAuthState = async ({ provider, stateKey }) => {
  const result = await db.query(
    `SELECT state_key, provider, payload_encrypted, expires_at
     FROM social_oauth_state
     WHERE state_key = $1
       AND provider = $2
     LIMIT 1`,
    [stateKey, provider]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Invalid OAuth state');
  }

  await db.query(
    'DELETE FROM social_oauth_state WHERE state_key = $1',
    [stateKey]
  );

  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new Error('OAuth state expired');
  }

  return JSON.parse(decryptSecret(row.payload_encrypted));
};

module.exports = {
  createOAuthState,
  consumeOAuthState
};
