const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

// In-memory challenge store (per user). Replace with Redis if needed.
const regChallenges = new Map();
const authChallenges = new Map();

function parseFrontendURL() {
  const url = process.env.FRONTEND_URL || 'http://localhost:5173';
  try {
    const u = new URL(url);
    return { origin: u.origin, rpID: u.hostname, rpName: 'Intellacc' };
  } catch {
    return { origin: 'http://localhost:5173', rpID: 'localhost', rpName: 'Intellacc' };
  }
}

// Start registration
router.post('/register/start', async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username || `user-${userId}`;
    const { rpID, rpName } = parseFrontendURL();

    // Fetch existing credentials to exclude
    const existing = await db.query('SELECT credential_id FROM device_credentials WHERE user_id = $1', [userId]);
    const excludeCredentials = existing.rows.map(r => ({ id: Buffer.from(r.credential_id, 'base64url'), type: 'public-key' }));

    // simplewebauthn v13 requires userID as a BufferSource (bytes), not string
    const enc = new TextEncoder();
    const userIDBytes = enc.encode(String(userId));

    const options = await generateRegistrationOptions({
      rpID,
      rpName,
      userID: userIDBytes,
      userName: username,
      userDisplayName: username,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' },
    });

    regChallenges.set(userId, options.challenge);
    res.json(options);
  } catch (e) {
    console.error('webauthn register/start error:', e);
    res.status(500).json({ error: 'failed to start registration' });
  }
});

// Finish registration
router.post('/register/finish', async (req, res) => {
  try {
    const userId = req.user.id;
    const expectedChallenge = regChallenges.get(userId);
    if (!expectedChallenge) return res.status(400).json({ error: 'no registration in progress' });

    const { origin, rpID } = parseFrontendURL();

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });

    if (!verification.verified) return res.status(400).json({ error: 'registration verification failed' });

    const { credentialID, credentialPublicKey, counter, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;

    await db.query(
      `INSERT INTO device_credentials (user_id, credential_id, public_key, sign_count, device_type, backed_up)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, credential_id) DO UPDATE SET public_key = EXCLUDED.public_key, sign_count = EXCLUDED.sign_count, device_type = EXCLUDED.device_type, backed_up = EXCLUDED.backed_up, last_used_at = NOW()`,
      [userId, Buffer.from(credentialID).toString('base64url'), credentialPublicKey.toString('base64'), counter || 0, credentialDeviceType || null, credentialBackedUp || false]
    );

    regChallenges.delete(userId);
    res.json({ success: true });
  } catch (e) {
    console.error('webauthn register/finish error:', e);
    res.status(500).json({ error: 'failed to finish registration' });
  }
});

// Start authentication
router.post('/auth/start', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rpID } = parseFrontendURL();

    const creds = await db.query('SELECT credential_id FROM device_credentials WHERE user_id = $1', [userId]);
    const allowCredentials = creds.rows.map(r => ({ id: Buffer.from(r.credential_id, 'base64url'), type: 'public-key' }));

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred',
    });

    authChallenges.set(userId, options.challenge);
    res.json(options);
  } catch (e) {
    console.error('webauthn auth/start error:', e);
    res.status(500).json({ error: 'failed to start auth' });
  }
});

// Finish authentication
router.post('/auth/finish', async (req, res) => {
  try {
    const userId = req.user.id;
    const expectedChallenge = authChallenges.get(userId);
    if (!expectedChallenge) return res.status(400).json({ error: 'no auth in progress' });

    const { origin, rpID } = parseFrontendURL();

    const getCredential = async (credIdB64Url) => {
      const q = await db.query('SELECT * FROM device_credentials WHERE user_id = $1 AND credential_id = $2', [userId, credIdB64Url]);
      return q.rows[0];
    };

    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      authenticator: await (async () => {
        const credId = Buffer.from(req.body.rawId, 'base64url').toString('base64url');
        const row = await getCredential(credId);
        if (!row) return null;
        return {
          credentialPublicKey: Buffer.from(row.public_key, 'base64'),
          credentialID: Buffer.from(row.credential_id, 'base64url'),
          counter: row.sign_count || 0,
        };
      })(),
    });

    if (!verification.verified) return res.status(400).json({ error: 'auth verification failed' });

    // Update sign_count and last_used_at
    const { newCounter } = verification.authenticationInfo || {};
    const credId = Buffer.from(req.body.rawId, 'base64url').toString('base64url');
    await db.query('UPDATE device_credentials SET sign_count = $1, last_used_at = NOW() WHERE user_id = $2 AND credential_id = $3', [newCounter || 0, userId, credId]);

    authChallenges.delete(userId);
    res.json({ success: true });
  } catch (e) {
    console.error('webauthn auth/finish error:', e);
    res.status(500).json({ error: 'failed to finish auth' });
  }
});

// Health/debug
router.get('/health', (req, res) => {
  const { origin, rpID, rpName } = parseFrontendURL();
  res.json({ ok: true, rpID, origin, rpName });
});

// List registered credentials for current user
router.get('/credentials', async (req, res) => {
  try {
    const userId = req.user.id;
    const rows = await db.query('SELECT credential_id, sign_count, device_type, backed_up, device_label, created_at, last_used_at FROM device_credentials WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json({ credentials: rows.rows });
  } catch (e) {
    res.status(500).json({ error: 'failed to list credentials' });
  }
});

module.exports = router;
