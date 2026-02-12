const crypto = require('crypto');
const { getRemoteActorByKeyId } = require('./remoteActorService');

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const parseSignatureHeader = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  const noPrefix = trimmed.toLowerCase().startsWith('signature ')
    ? trimmed.slice('signature '.length)
    : trimmed;

  const params = {};
  for (const part of noPrefix.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }

  if (!params.keyId || !params.signature) return null;
  return params;
};

const computeDigestHeader = (rawBody) => {
  const hash = crypto.createHash('sha256').update(rawBody || Buffer.alloc(0)).digest('base64');
  return `SHA-256=${hash}`;
};

const parseDigest = (value) => {
  const trimmed = String(value || '').trim();
  const idx = trimmed.indexOf('=');
  if (idx === -1) return null;
  return {
    alg: trimmed.slice(0, idx).trim().toLowerCase(),
    b64: trimmed.slice(idx + 1).trim()
  };
};

const buildSigningString = (req, headersList) => {
  const lines = [];

  for (const headerNameRaw of headersList) {
    const headerName = String(headerNameRaw || '').toLowerCase();
    if (!headerName) continue;

    if (headerName === '(request-target)') {
      lines.push(`(request-target): ${req.method.toLowerCase()} ${req.originalUrl}`);
      continue;
    }

    const headerValue = req.headers[headerName];
    if (headerValue === undefined) {
      throw new Error(`Missing signed header: ${headerName}`);
    }
    lines.push(`${headerName}: ${String(headerValue)}`);
  }

  if (lines.length === 0) {
    throw new Error('No signed headers');
  }

  return lines.join('\n');
};

const verifyHttpSignature = async (req) => {
  const signatureHeader = req.headers.signature || req.headers.Signature || req.get('Signature');
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    const err = new Error('Missing or invalid Signature header');
    err.statusCode = 401;
    throw err;
  }

  const headersList = String(parsed.headers || 'date')
    .split(' ')
    .map((h) => h.trim())
    .filter(Boolean);

  // Enforce Date freshness when present.
  if (req.headers.date) {
    const date = new Date(String(req.headers.date));
    if (Number.isNaN(date.getTime())) {
      const err = new Error('Invalid Date header');
      err.statusCode = 401;
      throw err;
    }
    const age = Math.abs(Date.now() - date.getTime());
    if (age > MAX_CLOCK_SKEW_MS) {
      const err = new Error('Signature Date header outside allowed skew');
      err.statusCode = 401;
      throw err;
    }
  }

  // Enforce Digest for POST requests (Mastodon signs + expects it).
  if (req.method === 'POST') {
    const got = parseDigest(req.headers.digest);
    const expected = parseDigest(computeDigestHeader(req.rawBody));
    if (!got || !expected || got.alg !== expected.alg || got.b64 !== expected.b64) {
      const err = new Error('Invalid Digest header');
      err.statusCode = 401;
      throw err;
    }
  }

  const remoteActor = await getRemoteActorByKeyId(parsed.keyId);
  const signingString = buildSigningString(req, headersList);

  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(signingString, 'utf8'),
    remoteActor.publicKeyPem,
    Buffer.from(parsed.signature, 'base64')
  );

  if (!ok) {
    const err = new Error('Signature verification failed');
    err.statusCode = 401;
    throw err;
  }

  return {
    keyId: parsed.keyId,
    headers: headersList,
    remoteActor
  };
};

module.exports = {
  verifyHttpSignature,
  computeDigestHeader
};
