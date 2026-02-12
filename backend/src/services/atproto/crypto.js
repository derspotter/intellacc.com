const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

const getSecret = () => {
  const configured = String(process.env.ATPROTO_CREDENTIAL_SECRET || '').trim();
  if (configured) return configured;

  const fallback = String(process.env.JWT_SECRET || '').trim();
  if (fallback) return fallback;

  // Dev fallback only; production must set ATPROTO_CREDENTIAL_SECRET.
  return 'dev-atproto-credential-secret-change-me';
};

const getKey = () => crypto.createHash('sha256').update(getSecret()).digest();

const toB64 = (buf) => Buffer.from(buf).toString('base64url');
const fromB64 = (value) => Buffer.from(String(value || ''), 'base64url');

const encryptSecret = (plaintext) => {
  const text = String(plaintext || '');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${toB64(iv)}.${toB64(tag)}.${toB64(encrypted)}`;
};

const decryptSecret = (ciphertext) => {
  const raw = String(ciphertext || '');
  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted secret format');
  }

  const iv = fromB64(parts[1]);
  const tag = fromB64(parts[2]);
  const encrypted = fromB64(parts[3]);

  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
};

module.exports = {
  encryptSecret,
  decryptSecret
};
