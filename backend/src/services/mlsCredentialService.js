// backend/src/services/mlsCredentialService.js

const db = require('../db');

async function insertCredentialRequest({ userId, clientId, ciphersuite, requestBytes }) {
  const result = await db.query(
    `INSERT INTO mls_credential_requests (user_id, client_id, ciphersuite, request_bytes)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, client_id, ciphersuite, status, created_at`,
    [userId, clientId, ciphersuite, requestBytes]
  );
  return result.rows[0];
}

async function completeCredentialRequest({ requestId, responseBytes }) {
  const result = await db.query(
    `UPDATE mls_credential_requests
        SET status = 'completed',
            completed_at = NOW()
      WHERE id = $1
      RETURNING id, user_id, client_id, ciphersuite, status, created_at, completed_at`,
    [requestId]
  );
  if (result.rowCount === 0) {
    throw new Error('Credential request not found');
  }
  return result.rows[0];
}

async function listCredentialRequests(userId, status = null) {
  const params = [userId];
  let query = `SELECT id, client_id, ciphersuite, status, created_at, completed_at
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
