const db = require('../../db');
const { getOAuthClient } = require('./oauthClientService');

const noAccountError = () => {
  const err = new Error('No connected ATProto account');
  err.code = 'ATPROTO_NO_ACCOUNT';
  return err;
};

const normalizePdsUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  return String(parsed).replace(/\/+$/, '');
};

const getAccountRowByUserId = async (userId) => {
  const result = await db.query(
    `SELECT user_id, did, handle, pds_url, is_enabled, created_at, updated_at
     FROM atproto_accounts
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
};

const getAccountRowByDid = async (did) => {
  const result = await db.query(
    `SELECT user_id, did, handle, pds_url, is_enabled, created_at, updated_at
     FROM atproto_accounts
     WHERE did = $1`,
    [did]
  );
  return result.rows[0] || null;
};

const toPublicAccount = (row) => {
  if (!row) return null;
  return {
    userId: row.user_id,
    did: row.did,
    handle: row.handle,
    pdsUrl: row.pds_url,
    isEnabled: row.is_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

const upsertLinkedAccount = async ({ userId, did, handle, pdsUrl }) => {
  if (!userId) throw new Error('Missing userId');
  if (!did) throw new Error('Missing DID');

  const normalizedHandle = String(handle || '').trim() || did;
  const normalizedPdsUrl = normalizePdsUrl(pdsUrl) || 'https://bsky.social';

  await db.query(
    `INSERT INTO atproto_accounts (user_id, did, handle, pds_url, is_enabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET did = EXCLUDED.did,
           handle = EXCLUDED.handle,
           pds_url = EXCLUDED.pds_url,
           is_enabled = TRUE,
           updated_at = NOW()`,
    [userId, did, normalizedHandle, normalizedPdsUrl]
  );

  return getLinkedAccountByUserId(userId);
};

const getLinkedAccountByUserId = async (userId) => {
  const row = await getAccountRowByUserId(userId);
  return toPublicAccount(row);
};

const getLinkedAccountByDid = async (did) => {
  const row = await getAccountRowByDid(did);
  return toPublicAccount(row);
};

const getConnectedAccount = async (userId) => {
  return getLinkedAccountByUserId(userId);
};

const disconnectAccount = async (userId) => {
  const row = await getAccountRowByUserId(userId);
  if (!row) return;

  try {
    await getOAuthClient().revoke(row.did);
  } catch (err) {
    console.warn('[ATProto] OAuth revoke failed during disconnect:', err?.message || err);
  }

  await db.query('DELETE FROM atproto_accounts WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM atproto_oauth_session WHERE sub = $1', [row.did]);
};

module.exports = {
  noAccountError,
  upsertLinkedAccount,
  getLinkedAccountByUserId,
  getLinkedAccountByDid,
  getConnectedAccount,
  disconnectAccount
};
