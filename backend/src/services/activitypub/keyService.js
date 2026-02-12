const crypto = require('crypto');
const db = require('../../db');

let cached = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

const generateRsaKeyPair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });

  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
};

const ensureServerKey = async () => {
  const now = Date.now();
  if (cached && (now - cachedAt) < CACHE_TTL_MS) return cached;

  const existing = await db.query(
    'SELECT id, private_key_pem, public_key_pem FROM ap_server_keys ORDER BY id ASC LIMIT 1'
  );

  if (existing.rows.length > 0) {
    cached = {
      id: existing.rows[0].id,
      privateKeyPem: existing.rows[0].private_key_pem,
      publicKeyPem: existing.rows[0].public_key_pem
    };
    cachedAt = now;
    return cached;
  }

  const keys = generateRsaKeyPair();
  const inserted = await db.query(
    'INSERT INTO ap_server_keys (private_key_pem, public_key_pem) VALUES ($1, $2) RETURNING id',
    [keys.privateKeyPem, keys.publicKeyPem]
  );

  cached = {
    id: inserted.rows[0].id,
    privateKeyPem: keys.privateKeyPem,
    publicKeyPem: keys.publicKeyPem
  };
  cachedAt = now;
  return cached;
};

module.exports = {
  ensureServerKey
};

