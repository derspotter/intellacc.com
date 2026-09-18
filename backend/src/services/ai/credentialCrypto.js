// AES-256-GCM encryption for user-supplied provider API keys.
//
// Dedicated secret: AI_CREDENTIAL_SECRET must be exactly 32 bytes, base64
// encoded (see docs/ai-assistant.md for how to generate one). There is
// deliberately no fallback to JWT_SECRET or a dev default: without a valid
// secret the assistant reports `available: false` and refuses to store keys.
//
// Every ciphertext is bound to the owning user id through the GCM additional
// authenticated data, so a ciphertext copied between rows fails to decrypt.
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = 'v1';

const loadKey = () => {
  const raw = String(process.env.AI_CREDENTIAL_SECRET || '').trim();
  if (!raw) return null;
  let key;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
  if (key.length !== KEY_BYTES) return null;
  // Round-trip check rejects strings that merely decode to 32 bytes by accident.
  if (key.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) return null;
  return key;
};

const isAvailable = () => loadKey() !== null;

const aadFor = (userId) => {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid credential owner');
  return Buffer.from(`intellacc-ai-credential:user:${id}`, 'utf8');
};

const encryptCredential = (plaintext, userId) => {
  const key = loadKey();
  if (!key) throw new Error('AI credential secret is not configured');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  cipher.setAAD(aadFor(userId));
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
};

const decryptCredential = (ciphertext, userId) => {
  const key = loadKey();
  if (!key) throw new Error('AI credential secret is not configured');
  const parts = String(ciphertext || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Invalid credential ciphertext');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const encrypted = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('Invalid credential ciphertext');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAAD(aadFor(userId));
  decipher.setAuthTag(tag);
  // Throws on any tampering or on a mismatched owner (AAD).
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};

module.exports = { isAvailable, encryptCredential, decryptCredential, KEY_BYTES };
