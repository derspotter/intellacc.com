// backend/src/services/e2eeService.js
// Minimal services for Signal key bundles (identity, signed prekey, one-time prekeys)

const db = require('../db');

const DEFAULT_DEVICE_ID = 'default';

async function publishIdentity(userId, identityKey, signingKey, deviceId = DEFAULT_DEVICE_ID) {
  const q = `
    INSERT INTO e2ee_devices (user_id, device_id, identity_pub, signing_pub)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, device_id)
    DO UPDATE SET identity_pub = EXCLUDED.identity_pub, signing_pub = EXCLUDED.signing_pub, created_at = NOW()
  `;
  await db.query(q, [userId, deviceId, identityKey, signingKey]);
  return { success: true };
}

async function publishPrekeys(userId, signedPreKey, oneTimePreKeys = [], deviceId = DEFAULT_DEVICE_ID) {
  // Upsert signed prekey
  if (signedPreKey && typeof signedPreKey === 'object') {
    const { keyId, publicKey, signature } = signedPreKey;
    if (Number.isInteger(keyId) && publicKey && signature) {
      const q = `
        INSERT INTO e2ee_signed_prekeys (user_id, device_id, key_id, public_key, signature)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, device_id, key_id)
        DO UPDATE SET public_key = EXCLUDED.public_key, signature = EXCLUDED.signature, created_at = NOW()
      `;
      await db.query(q, [userId, deviceId, keyId, publicKey, signature]);
    }
  }

  // Insert one-time prekeys; ignore duplicates
  if (Array.isArray(oneTimePreKeys) && oneTimePreKeys.length > 0) {
    const values = [];
    const params = [];
    let idx = 1;
    for (const pk of oneTimePreKeys) {
      if (!Number.isInteger(pk.keyId) || !pk.publicKey) continue;
      params.push(userId, deviceId, pk.keyId, pk.publicKey);
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    }
    if (values.length > 0) {
      const q = `
        INSERT INTO e2ee_one_time_prekeys (user_id, device_id, key_id, public_key)
        VALUES ${values.join(',')}
        ON CONFLICT (user_id, device_id, key_id) DO NOTHING
      `;
      await db.query(q, params);
    }
  }
  return { success: true };
}

async function getKeyBundle(targetUserId, deviceId = DEFAULT_DEVICE_ID) {
  // Identity
  const idQ = `SELECT identity_pub, signing_pub FROM e2ee_devices WHERE user_id = $1 AND device_id = $2`;
  const idRes = await db.query(idQ, [targetUserId, deviceId]);
  if (idRes.rowCount === 0) {
    return null; // No identity published
  }
  const identityKey = idRes.rows[0].identity_pub;
  // Latest signed prekey by created_at
  const spQ = `
    SELECT key_id, public_key, signature
    FROM e2ee_signed_prekeys
    WHERE user_id = $1 AND device_id = $2
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const spRes = await db.query(spQ, [targetUserId, deviceId]);
  const signedPreKey = spRes.rowCount > 0 ? {
    keyId: spRes.rows[0].key_id,
    publicKey: spRes.rows[0].public_key,
    signature: spRes.rows[0].signature,
  } : null;

  // Atomically reserve a one-time prekey (best-effort)
  let oneTimePreKey = null;
  const reserveQ = `
    WITH next_prekey AS (
      SELECT key_id
      FROM e2ee_one_time_prekeys
      WHERE user_id = $1 AND device_id = $2 AND used = FALSE AND reserved = FALSE
      ORDER BY key_id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE e2ee_one_time_prekeys p
    SET reserved = TRUE, reserved_at = NOW()
    FROM next_prekey n
    WHERE p.user_id = $1 AND p.device_id = $2 AND p.key_id = n.key_id
    RETURNING p.key_id, p.public_key
  `;
  const r = await db.query(reserveQ, [targetUserId, deviceId]);
  if (r.rowCount === 1) {
    oneTimePreKey = { keyId: r.rows[0].key_id, publicKey: r.rows[0].public_key };
  }

  return {
    identityKey,
    signedPreKey,
    oneTimePreKey,
  };
}

module.exports = {
  publishIdentity,
  publishPrekeys,
  getKeyBundle,
  markPrekeyUsed,
};

// Mark a reserved prekey as used
async function markPrekeyUsed(userId, deviceId = DEFAULT_DEVICE_ID, keyId) {
  if (!Number.isInteger(keyId)) return 0;
  const q = `
    UPDATE e2ee_one_time_prekeys
    SET used = TRUE, reserved = FALSE, used_at = NOW()
    WHERE user_id = $1 AND device_id = $2 AND key_id = $3 AND used = FALSE AND reserved = TRUE
  `;
  const res = await db.query(q, [userId, deviceId, keyId]);
  return res.rowCount;
}
