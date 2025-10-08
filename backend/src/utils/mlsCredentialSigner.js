// backend/src/utils/mlsCredentialSigner.js
// Helpers for parsing, signing, and verifying MLS credential provisioning payloads.

const { Buffer } = require('buffer');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const DEFAULT_ISSUER_ID = process.env.MLS_CREDENTIAL_ISSUER_ID || 'intellacc-issuer';
const DEFAULT_TTL_SECONDS = Math.max(Number(process.env.MLS_CREDENTIAL_TTL_SECONDS || 0) || (30 * 24 * 60 * 60), 60);

let cachedKeyPair = null;

function decodeSeed(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  const withoutPrefix = trimmed.replace(/^(base64:|hex:)/i, '');
  // Try base64 first
  try {
    const base64 = Buffer.from(withoutPrefix, 'base64');
    if (base64.length === 32) return base64;
  } catch {}

  // Try hex
  try {
    const hex = Buffer.from(withoutPrefix, 'hex');
    if (hex.length === 32) return hex;
  } catch {}

  throw new Error('MLS_CREDENTIAL_ISSUER_KEY must be a 32-byte seed encoded as base64 or hex');
}

function getIssuerSeed() {
  if (cachedKeyPair) return cachedKeyPair;

  const envSeed = decodeSeed(process.env.MLS_CREDENTIAL_ISSUER_KEY);
  let seed = envSeed;
  if (!seed) {
    const fallbackSource = process.env.JWT_SECRET || 'intellacc-development-mls-issuer';
    seed = crypto.createHash('sha256').update(fallbackSource).digest().subarray(0, 32);
    console.warn('[MLS] MLS_CREDENTIAL_ISSUER_KEY not set; using derived development seed');
  }

  const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
  cachedKeyPair = {
    seed,
    publicKey: Buffer.from(keyPair.publicKey),
    secretKey: Buffer.from(keyPair.secretKey)
  };
  return cachedKeyPair;
}

function decodeBase64(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Credential ${field} must be a base64 string`);
  }
  try {
    return Buffer.from(value, 'base64');
  } catch {
    throw new Error(`Credential ${field} is not valid base64`);
  }
}

function parseCredentialRequest(requestBytes) {
  let parsed;
  try {
    parsed = JSON.parse(requestBytes.toString('utf8'));
  } catch {
    throw new Error('Credential request payload must be valid JSON');
  }

  const version = Number(parsed.version ?? 1);
  const subject = parsed.subject || {};
  const userIdValue = subject.userId ?? parsed.userId ?? null;
  const clientIdValue = subject.clientId ?? parsed.clientId ?? null;

  const userId = userIdValue != null ? Number(userIdValue) : null;
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Credential request missing valid subject.userId');
  }

  if (typeof clientIdValue !== 'string' || clientIdValue.trim() === '') {
    throw new Error('Credential request missing subject.clientId');
  }

  const ciphersuite = Number(parsed.ciphersuite ?? 1);
  if (!Number.isInteger(ciphersuite) || ciphersuite <= 0) {
    throw new Error('Credential request missing valid ciphersuite');
  }

  const credentialType = String(parsed.credentialType || 'basic').toLowerCase();
  if (credentialType !== 'basic') {
    throw new Error(`Unsupported credentialType "${credentialType}"`);
  }

  if (!parsed.publicKey) {
    throw new Error('Credential request missing publicKey');
  }
  const publicKey = decodeBase64(parsed.publicKey, 'publicKey');
  if (publicKey.length !== 32) {
    throw new Error('Credential request publicKey must be 32 bytes');
  }

  let nonce = null;
  if (parsed.nonce) {
    const nonceBytes = decodeBase64(parsed.nonce, 'nonce');
    if (nonceBytes.length < 8) {
      throw new Error('Credential request nonce must be at least 8 bytes');
    }
    nonce = parsed.nonce;
  }

  const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : null;

  return {
    version,
    userId,
    clientId: clientIdValue,
    ciphersuite,
    credentialType,
    publicKey,
    publicKeyB64: parsed.publicKey,
    nonce,
    createdAt,
    raw: parsed
  };
}

function signCredentialRequest(requestBytes, requestMeta, options = {}) {
  const { publicKey, secretKey } = getIssuerSeed();
  const now = options.now || new Date();
  const ttlSeconds = Math.max(Number(options.ttlSeconds || DEFAULT_TTL_SECONDS) || DEFAULT_TTL_SECONDS, 60);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  const hash = crypto.createHash('sha256').update(requestBytes).digest('base64');
  const signature = Buffer.from(nacl.sign.detached(new Uint8Array(requestBytes), new Uint8Array(secretKey)));

  const responsePayload = {
    version: 1,
    credential: {
      subject: {
        userId: requestMeta.userId,
        clientId: requestMeta.clientId
      },
      credentialType: requestMeta.credentialType,
      ciphersuite: requestMeta.ciphersuite,
      publicKey: requestMeta.publicKeyB64,
      nonce: requestMeta.nonce,
      createdAt: requestMeta.createdAt || now.toISOString(),
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    },
    requestHash: hash,
    signer: {
      id: options.issuerId || DEFAULT_ISSUER_ID,
      algorithm: 'ed25519',
      publicKey: publicKey.toString('base64')
    },
    signature: signature.toString('base64')
  };

  return {
    response: responsePayload,
    responseBytes: Buffer.from(JSON.stringify(responsePayload), 'utf8'),
    expiresAt,
    issuedAt: now
  };
}

function verifyCredentialResponse(requestBytes, responseBytes) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(responseBytes).toString('utf8'));
  } catch {
    throw new Error('Credential response payload must be valid JSON');
  }

  if (!payload?.signature || !payload?.requestHash) {
    throw new Error('Credential response missing signature metadata');
  }

  const expectedHash = crypto.createHash('sha256').update(requestBytes).digest('base64');
  if (payload.requestHash !== expectedHash) {
    throw new Error('Credential response does not match request hash');
  }

  const signerKey = decodeBase64(payload?.signer?.publicKey, 'signer.publicKey');
  const signature = decodeBase64(payload.signature, 'signature');

  const valid = nacl.sign.detached.verify(new Uint8Array(requestBytes), new Uint8Array(signature), new Uint8Array(signerKey));
  if (!valid) {
    throw new Error('Credential response signature verification failed');
  }

  return payload;
}

module.exports = {
  parseCredentialRequest,
  signCredentialRequest,
  verifyCredentialResponse,
  getIssuerSeed
};
