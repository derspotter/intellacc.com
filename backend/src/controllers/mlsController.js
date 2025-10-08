// backend/src/controllers/mlsController.js

const { Buffer } = require('buffer');
const mlsService = require('../services/mlsService');
const messagingService = require('../services/messagingService');

function decodeBase64Field(value, fieldName, { optional = false } = {}) {
  if (value == null) {
    if (optional) return null;
    throw new Error(`Missing required field: ${fieldName}`);
  }

  if (typeof value !== 'string' || value.trim() === '') {
    if (optional) return null;
    throw new Error(`Field ${fieldName} must be a non-empty base64 string`);
  }

  try {
    return Buffer.from(value, 'base64');
  } catch {
    throw new Error(`Field ${fieldName} is not valid base64`);
  }
}

const normalizeUserId = (user) => {
  if (!user) return null;
  return user.userId ?? user.id ?? null;
};

exports.publishKeyPackages = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const {
      clientId,
      ciphersuite,
      credentialType = 'basic',
      keyPackages
    } = req.body || {};

    if (!clientId || typeof clientId !== 'string') {
      return res.status(400).json({ message: 'clientId is required' });
    }

    const ciphersuiteInt = Number(ciphersuite);
    if (!Number.isInteger(ciphersuiteInt)) {
      return res.status(400).json({ message: 'ciphersuite must be an integer' });
    }

    if (!Array.isArray(keyPackages) || keyPackages.length === 0) {
      return res.status(400).json({ message: 'keyPackages must be a non-empty array' });
    }

    const decodedPackages = [];
    for (const kp of keyPackages) {
      try {
        decodedPackages.push(Buffer.from(kp, 'base64'));
      } catch {
        return res.status(400).json({ message: 'keyPackages must be base64 encoded strings' });
      }
    }

    await mlsService.replaceKeyPackages({
      userId,
      clientId,
      ciphersuite: ciphersuiteInt,
      credentialType: String(credentialType),
      keyPackages: decodedPackages
    });

    return res.status(204).send();
  } catch (error) {
    console.error('Error publishing MLS key packages:', error);
    return res.status(500).json({ message: 'Failed to publish key packages' });
  }
};

exports.postCommitBundle = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const {
      conversationId,
      senderClientId,
      bundle,
      welcome,
      groupInfo,
      encryptedMessage
    } = req.body || {};

    const numericConversationId = Number(conversationId);
    if (!Number.isInteger(numericConversationId)) {
      return res.status(400).json({ message: 'conversationId must be an integer' });
    }

    if (!senderClientId || typeof senderClientId !== 'string') {
      return res.status(400).json({ message: 'senderClientId is required' });
    }

    const isParticipant = await messagingService.checkConversationMembership(numericConversationId, userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant in this conversation' });
    }

    let commitBuffer;
    let welcomeBuffer = null;
    let groupInfoBuffer = null;
    let encryptedMessageBuffer = null;

    try {
      commitBuffer = decodeBase64Field(bundle, 'bundle');
      welcomeBuffer = decodeBase64Field(welcome, 'welcome', { optional: true });
      groupInfoBuffer = decodeBase64Field(groupInfo, 'groupInfo', { optional: true });
      encryptedMessageBuffer = decodeBase64Field(encryptedMessage, 'encryptedMessage', { optional: true });
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const record = await mlsService.insertCommitBundle({
      conversationId: numericConversationId,
      userId,
      senderClientId,
      bundle: commitBuffer,
      welcome: welcomeBuffer,
      groupInfo: groupInfoBuffer,
      encryptedMessage: encryptedMessageBuffer
    });

    const participants = await mlsService.getConversationParticipants(numericConversationId);
    const payload = {
      conversationId: numericConversationId,
      senderClientId,
      bundle,
      welcome,
      groupInfo,
      encryptedMessage,
      createdAt: record?.created_at ?? new Date().toISOString()
    };

    messagingService.emitToConversationRoom(numericConversationId, 'mls:commit', payload);
    messagingService.emitToUsers('mls:commit', payload, participants);

    return res.status(204).send();
  } catch (error) {
    console.error('Error persisting MLS commit bundle:', error);
    return res.status(500).json({ message: 'Failed to accept commit bundle' });
  }
};

exports.postApplicationMessage = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const {
      conversationId,
      senderClientId,
      epoch,
      ciphertext
    } = req.body || {};

    const numericConversationId = Number(conversationId);
    if (!Number.isInteger(numericConversationId)) {
      return res.status(400).json({ message: 'conversationId must be an integer' });
    }

    if (!senderClientId || typeof senderClientId !== 'string') {
      return res.status(400).json({ message: 'senderClientId is required' });
    }

    const isParticipant = await messagingService.checkConversationMembership(numericConversationId, userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant in this conversation' });
    }

    let ciphertextBuffer;
    try {
      ciphertextBuffer = decodeBase64Field(ciphertext, 'ciphertext');
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const epochValue = epoch === undefined || epoch === null ? null : Number(epoch);
    if (epochValue !== null && !Number.isInteger(epochValue)) {
      return res.status(400).json({ message: 'epoch must be an integer when provided' });
    }

    const record = await mlsService.insertApplicationMessage({
      conversationId: numericConversationId,
      userId,
      senderClientId,
      epoch: epochValue,
      ciphertext: ciphertextBuffer
    });

    const participants = await mlsService.getConversationParticipants(numericConversationId);
    const payload = {
      conversationId: numericConversationId,
      senderClientId,
      epoch: epochValue,
      ciphertext,
      createdAt: record?.created_at ?? new Date().toISOString()
    };

    messagingService.emitToConversationRoom(numericConversationId, 'mls:message', payload);
    messagingService.emitToUsers('mls:message', payload, participants);

    return res.status(204).send();
  } catch (error) {
    console.error('Error persisting MLS application message:', error);
    return res.status(500).json({ message: 'Failed to accept MLS message' });
  }
};
