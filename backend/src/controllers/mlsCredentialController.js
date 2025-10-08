// backend/src/controllers/mlsCredentialController.js

const { Buffer } = require('buffer');
const mlsCredentialService = require('../services/mlsCredentialService');

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

    const record = await mlsCredentialService.insertCredentialRequest({
      userId,
      clientId,
      ciphersuite: ciphersuiteInt,
      requestBytes
    });

    return res.status(201).json({
      id: record.id,
      clientId: record.client_id,
      ciphersuite: record.ciphersuite,
      status: record.status,
      createdAt: record.created_at
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

    const record = await mlsCredentialService.completeCredentialRequest({
      requestId,
      responseBytes
    });

    return res.status(200).json({
      id: record.id,
      status: record.status,
      completedAt: record.completed_at
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
    const items = await mlsCredentialService.listCredentialRequests(userId, status || null);
    return res.status(200).json({ items });
  } catch (error) {
    console.error('Error listing MLS credential requests:', error);
    return res.status(500).json({ message: 'Failed to list credential requests' });
  }
};
