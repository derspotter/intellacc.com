// backend/src/services/mlsCredentialService.js

const { Buffer } = require('buffer');
const db = require('../db');

async function insertCredentialRequest({ userId, clientId, ciphersuite, requestBytes, responseBytes, expiresAt }) {
  const result = await db.query(
    `INSERT INTO mls_credential_requests (user_id, client_id, ciphersuite, request_bytes, response_bytes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, client_id, ciphersuite, status, created_at, expires_at, response_bytes`,
    [userId, clientId, ciphersuite, requestBytes, responseBytes ?? null, expiresAt || null]
  );
  return result.rows[0];
}

async function completeCredentialRequest({ requestId, userId, responseBytes, verify }) {
  const pool = db.getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id, user_id, client_id, ciphersuite, status, request_bytes, response_bytes, created_at, completed_at, expires_at
         FROM mls_credential_requests
        WHERE id = $1
        FOR UPDATE`,
      [requestId]
    );

    if (existing.rowCount === 0) {
      throw new Error('Credential request not found');
    }

    const record = existing.rows[0];
    if (Number(record.user_id) !== Number(userId)) {
      throw new Error('Credential request does not belong to this user');
    }

    if (record.status === 'completed') {
      if (record.response_bytes && responseBytes && Buffer.compare(record.response_bytes, responseBytes) === 0) {
        await client.query('COMMIT');
        return record;
      }
      throw new Error('Credential request already completed');
    }

    if (typeof verify === 'function') {
      verify(record, responseBytes);
    }

    if (record.response_bytes && responseBytes && Buffer.compare(record.response_bytes, responseBytes) !== 0) {
      throw new Error('Credential response does not match stored signature');
    }

    await client.query(
      `UPDATE mls_credential_requests
          SET status = 'completed',
              response_bytes = COALESCE(response_bytes, $2),
              completed_at = NOW()
        WHERE id = $1`,
      [requestId, responseBytes || null]
    );

    const updated = await client.query(
      `SELECT id, user_id, client_id, ciphersuite, status, created_at, completed_at, expires_at
         FROM mls_credential_requests
        WHERE id = $1`,
      [requestId]
    );

    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listCredentialRequests(userId, status = null) {
  const params = [userId];
  let query = `SELECT id, client_id, ciphersuite, status, created_at, completed_at, expires_at
                 FROM mls_credential_requests
                WHERE user_id = $1`;
  if (status) {
    params.push(status);
    query += ' AND status = $2';
  }
  query += ' ORDER BY created_at DESC';
  const result = await db.query(query, params);
  return result.rows;
}

module.exports = {
  insertCredentialRequest,
  completeCredentialRequest,
  listCredentialRequests
};
