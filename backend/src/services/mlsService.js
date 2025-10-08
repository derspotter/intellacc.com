// backend/src/services/mlsService.js

const db = require('../db');

/**
 * Replace all MLS key packages for a given user/client/ciphersuite tuple.
 * @param {Object} params
 * @param {number} params.userId
 * @param {string} params.clientId
 * @param {number} params.ciphersuite
 * @param {string} params.credentialType
 * @param {Buffer[]} params.keyPackages
 */
async function replaceKeyPackages({ userId, clientId, ciphersuite, credentialType, keyPackages }) {
  const pool = db.getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM mls_key_packages WHERE user_id = $1 AND client_id = $2 AND ciphersuite = $3',
      [userId, clientId, ciphersuite]
    );

    for (const keyPackage of keyPackages) {
      await client.query(
        `INSERT INTO mls_key_packages (user_id, client_id, ciphersuite, credential_type, key_package)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, clientId, ciphersuite, credentialType, keyPackage]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Persist a commit bundle emitted by a client.
 */
async function insertCommitBundle({
  conversationId,
  userId,
  senderClientId,
  bundle,
  welcome,
  groupInfo,
  encryptedMessage
}) {
  const result = await db.query(
    `INSERT INTO mls_commit_bundles (
       conversation_id, user_id, sender_client_id, commit_bundle, welcome, group_info, encrypted_message
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [conversationId, userId, senderClientId, bundle, welcome, groupInfo, encryptedMessage]
  );
  return result.rows[0];
}

/**
 * Persist a plain MLS application message.
 */
async function insertApplicationMessage({
  conversationId,
  userId,
  senderClientId,
  epoch,
  ciphertext
}) {
  const result = await db.query(
    `INSERT INTO mls_messages (
       conversation_id, user_id, sender_client_id, epoch, ciphertext
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [conversationId, userId, senderClientId, epoch, ciphertext]
  );
  await db.query(
    `UPDATE conversations
        SET last_message_at = GREATEST(NOW(), COALESCE(last_message_at, NOW())),
            updated_at = NOW()
      WHERE id = $1`,
    [conversationId]
  );
  return result.rows[0];
}

async function insertHistorySecret({
  conversationId,
  userId,
  senderClientId,
  epoch,
  secret
}) {
  const result = await db.query(
    `INSERT INTO mls_history_secrets (
       conversation_id, sender_user_id, sender_client_id, epoch, secret
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [conversationId, userId, senderClientId, epoch ?? null, secret]
  );
  return result.rows[0];
}

/**
 * Fetch the participants for a conversation (two-party today).
 */
async function getConversationParticipants(conversationId) {
  const result = await db.query(
    `SELECT participant_1, participant_2
       FROM conversations
      WHERE id = $1`,
    [conversationId]
  );

  if (result.rowCount === 0) {
    return [];
  }

  const { participant_1, participant_2 } = result.rows[0];
  return [participant_1, participant_2].filter(Boolean);
}

async function listApplicationMessages(conversationId, userId, limit = 50, before = null) {
  const params = [conversationId, limit];
  let query = `
    SELECT id, conversation_id, user_id, sender_client_id, epoch, ciphertext, created_at
      FROM mls_messages
     WHERE conversation_id = $1
  `;
  if (before) {
    params.push(before);
    query += ` AND created_at < $${params.length}`;
  }
  query += ' ORDER BY created_at DESC LIMIT $2';
  const result = await db.query(query, params);
  return result.rows;
}

async function listKeyPackages({ userId, ciphersuite, limit }) {
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
  const result = await db.query(
    `SELECT id, client_id, credential_type, key_package, created_at
       FROM mls_key_packages
      WHERE user_id = $1 AND ciphersuite = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [userId, ciphersuite, cappedLimit]
  );
  return result.rows;
}

module.exports = {
  replaceKeyPackages,
  insertCommitBundle,
  insertApplicationMessage,
  insertHistorySecret,
  getConversationParticipants,
  listApplicationMessages,
  listKeyPackages
};
