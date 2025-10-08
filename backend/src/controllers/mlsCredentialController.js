// backend/src/controllers/mlsCredentialController.js

const { Buffer } = require('buffer');
const mlsCredentialService = require('../services/mlsCredentialService');
const {
  parseCredentialRequest,
  signCredentialRequest,
  verifyCredentialResponse
} = require('../utils/mlsCredentialSigner');

function normalizeUserId(user) {
  if (!user) return null;
  return user.userId ?? user.id ?? null;
}

function decodeBase64(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Field ${fieldName} must be a base64 string`);
  }
  try {
    return Buffer.from(value, 'base64');
  } catch {
    throw new Error(`Field ${fieldName} is not valid base64`);
  }
}

exports.createCredentialRequest = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const {
      clientId,
      ciphersuite = 1,
      request
    } = req.body || {};

    if (!clientId || typeof clientId !== 'string') {
      return res.status(400).json({ message: 'clientId is required' });
    }

    const ciphersuiteInt = Number(ciphersuite);
    if (!Number.isInteger(ciphersuiteInt)) {
      return res.status(400).json({ message: 'ciphersuite must be an integer' });
    }

    if (!request) {
      return res.status(400).json({ message: 'request is required (base64)' });
    }

    let requestBytes;
    try {
      requestBytes = decodeBase64(request, 'request');
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    if (requestBytes.length > 32 * 1024) {
      return res.status(413).json({ message: 'credential request too large' });
    }

    let requestMeta;
    try {
      requestMeta = parseCredentialRequest(requestBytes);
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    if (Number(requestMeta.userId) !== Number(userId)) {
      return res.status(400).json({ message: 'Credential request subject does not match user' });
    }

    if (requestMeta.clientId !== clientId) {
      return res.status(400).json({ message: 'Credential request clientId mismatch' });
    }

    if (Number(requestMeta.ciphersuite) !== ciphersuiteInt) {
      return res.status(400).json({ message: 'Credential request ciphersuite mismatch' });
    }

    const signed = signCredentialRequest(requestBytes, requestMeta);

    const record = await mlsCredentialService.insertCredentialRequest({
      userId,
      clientId,
      ciphersuite: ciphersuiteInt,
      requestBytes,
      responseBytes: signed.responseBytes,
      expiresAt: signed.expiresAt
    });

    return res.status(201).json({
      id: record.id,
      clientId: record.client_id,
      ciphersuite: record.ciphersuite,
      status: record.status,
      createdAt: record.created_at,
      expiresAt: record.expires_at,
      credential: signed.responseBytes.toString('base64'),
      issuedAt: signed.response?.credential?.issuedAt,
      signer: signed.response?.signer,
      requestHash: signed.response?.requestHash
    });
  } catch (error) {
    console.error('Error creating MLS credential request:', error);
    return res.status(500).json({ message: 'Failed to store credential request' });
  }
};

exports.completeCredential = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { requestId, response } = req.body || {};
    if (!Number.isInteger(requestId)) {
      return res.status(400).json({ message: 'requestId (integer) is required' });
    }

    if (!response) {
      return res.status(400).json({ message: 'response is required (base64)' });
    }

    let responseBytes;
    try {
      responseBytes = decodeBase64(response, 'response');
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    if (responseBytes.length > 32 * 1024) {
      return res.status(413).json({ message: 'credential response too large' });
    }

    let verifiedPayload = null;
    const record = await mlsCredentialService.completeCredentialRequest({
      requestId,
      userId,
      responseBytes,
      verify: (storedRecord, incomingBytes) => {
        const payload = verifyCredentialResponse(storedRecord.request_bytes, incomingBytes);
        const subject = payload?.credential?.subject || {};

        if (Number(subject.userId ?? 0) !== Number(userId)) {
          throw new Error('Credential response subject does not match user');
        }
        if (subject.clientId && subject.clientId !== storedRecord.client_id) {
          throw new Error('Credential response clientId mismatch');
        }
        verifiedPayload = payload;
      }
    });

    return res.status(200).json({
      id: record.id,
      status: record.status,
      completedAt: record.completed_at,
      expiresAt: record.expires_at,
      credential: verifiedPayload?.credential ?? null
    });
  } catch (error) {
    console.error('Error completing MLS credential request:', error);
    return res.status(500).json({ message: 'Failed to complete credential request' });
  }
};

exports.listCredentials = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { status } = req.query || {};
    const rows = await mlsCredentialService.listCredentialRequests(userId, status || null);
    const items = rows.map(row => ({
      id: row.id,
      clientId: row.client_id,
      ciphersuite: row.ciphersuite,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      expiresAt: row.expires_at
    }));
    return res.status(200).json({ items });
  } catch (error) {
    console.error('Error listing MLS credential requests:', error);
    return res.status(500).json({ message: 'Failed to list credential requests' });
  }
};
