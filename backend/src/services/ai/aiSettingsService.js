// Per-user provider settings for the personal BYOK assistant.
const db = require('../../db');
const { isAvailable, encryptCredential, decryptCredential } = require('./credentialCrypto');
const { PROVIDER_IDS, isValidProvider, isValidModel, isValidApiKey, AiProviderError } = require('./providers');

const DEFAULT_PROVIDER = 'openrouter';

class AiValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AiValidationError';
    this.status = status;
  }
}

const keyHintFor = (apiKey) => `…${apiKey.slice(-4)}`;

const describe = (row) => ({
  configured: Boolean(row && row.key_ciphertext),
  provider: row?.provider || DEFAULT_PROVIDER,
  model: row?.model || '',
  keyHint: row?.key_hint || '',
  publicReplies: Boolean(row?.public_replies),
  available: isAvailable()
});

const getSettings = async (userId) => {
  const result = await db.query(
    'SELECT provider, model, key_ciphertext, key_hint, public_replies FROM user_ai_settings WHERE user_id = $1',
    [userId]
  );
  return describe(result.rows[0]);
};

// Empty/omitted apiKey keeps the stored key only when the provider is
// unchanged; switching providers always requires a fresh key.
const saveSettings = async (userId, { provider, model, apiKey, publicReplies } = {}) => {
  if (!isAvailable()) throw new AiValidationError('The AI assistant is not available on this server', 503);
  if (!isValidProvider(provider)) throw new AiValidationError(`provider must be one of ${PROVIDER_IDS.join(', ')}`);
  const cleanModel = typeof model === 'string' ? model.trim() : '';
  if (!isValidModel(cleanModel)) throw new AiValidationError('model must be a provider model id (1-128 chars, letters, digits, . _ : / -)');
  if (typeof publicReplies !== 'boolean') throw new AiValidationError('publicReplies must be true or false');
  const rawKey = apiKey === undefined || apiKey === null ? '' : String(apiKey).trim();
  if (rawKey && !isValidApiKey(rawKey)) throw new AiValidationError('apiKey must be 8-512 printable characters without spaces');

  const existing = (await db.query(
    'SELECT provider, key_ciphertext, key_hint FROM user_ai_settings WHERE user_id = $1',
    [userId]
  )).rows[0];

  let keyCiphertext;
  let keyHint;
  if (rawKey) {
    keyCiphertext = encryptCredential(rawKey, userId);
    keyHint = keyHintFor(rawKey);
  } else if (existing && existing.key_ciphertext && existing.provider === provider) {
    keyCiphertext = existing.key_ciphertext;
    keyHint = existing.key_hint;
  } else {
    throw new AiValidationError('apiKey is required for this provider');
  }

  const result = await db.query(
    `INSERT INTO user_ai_settings (user_id, provider, model, key_ciphertext, key_hint, public_replies)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model,
       key_ciphertext = EXCLUDED.key_ciphertext, key_hint = EXCLUDED.key_hint,
       public_replies = EXCLUDED.public_replies, updated_at = NOW()
     RETURNING provider, model, key_ciphertext, key_hint, public_replies`,
    [userId, provider, cleanModel, keyCiphertext, keyHint, publicReplies]
  );
  return describe(result.rows[0]);
};

const deleteSettings = async (userId) => {
  await db.query('DELETE FROM user_ai_settings WHERE user_id = $1', [userId]);
};

// Decrypted credentials for inference. Returns null when nothing is saved.
// Accepts an optional client so callers can read inside their transaction.
const loadCredentials = async (userId, client = db) => {
  if (!isAvailable()) throw new AiProviderError('not_configured', 'The AI assistant is not available on this server');
  const row = (await client.query(
    'SELECT provider, model, key_ciphertext, public_replies FROM user_ai_settings WHERE user_id = $1',
    [userId]
  )).rows[0];
  if (!row || !row.key_ciphertext) return null;
  let apiKey;
  try {
    apiKey = decryptCredential(row.key_ciphertext, userId);
  } catch {
    throw new AiProviderError('not_configured', 'Your saved API key can no longer be read; please enter it again');
  }
  return { provider: row.provider, model: row.model || '', apiKey, publicReplies: Boolean(row.public_replies) };
};

module.exports = { AiValidationError, DEFAULT_PROVIDER, getSettings, saveSettings, deleteSettings, loadCredentials, keyHintFor };
