// backend/src/controllers/mlsController.js

const { Buffer } = require('buffer');
const mlsService = require('../services/mlsService');
const messagingService = require('../services/messagingService');
const mlsConversationService = require('../services/mlsConversationService');
const DEFAULT_CIPHERSUITE = Number(process.env.MLS_DEFAULT_CIPHERSUITE ?? 1);

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

exports.listKeyPackages = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId)) {
      return res.status(400).json({ message: 'userId must be an integer' });
    }

    const { ciphersuite = 1, limit = 5 } = req.query || {};
    const ciphersuiteInt = Number(ciphersuite);
    if (!Number.isInteger(ciphersuiteInt)) {
      return res.status(400).json({ message: 'ciphersuite must be an integer' });
    }

    const keyPackages = await mlsService.listKeyPackages({
      userId: targetUserId,
      ciphersuite: ciphersuiteInt,
      limit: Number(limit) || 5
    });

    const items = keyPackages.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      credentialType: row.credential_type,
      keyPackage: row.key_package?.toString('base64') ?? null,
      createdAt: row.created_at
    })).filter((item) => item.keyPackage);

    return res.status(200).json({ items });
  } catch (error) {
    console.error('Error listing MLS key packages:', error);
    return res.status(500).json({ message: 'Failed to list MLS key packages' });
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

    if (groupInfoBuffer) {
      try {
        await mlsConversationService.updateGroupInfo({
          conversationId: numericConversationId,
          groupInfo: groupInfoBuffer
        });
      } catch (updateErr) {
        console.warn('Failed to persist MLS group info payload', updateErr);
      }
    }

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

exports.postHistorySecret = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const {
      conversationId,
      senderClientId,
      epoch,
      data
    } = req.body || {};

    if (!data) {
      return res.status(400).json({ message: 'data is required' });
    }

    if (!senderClientId || typeof senderClientId !== 'string') {
      return res.status(400).json({ message: 'senderClientId is required' });
    }

    const numericConversationId = Number(conversationId);
    if (!Number.isInteger(numericConversationId)) {
      return res.status(400).json({ message: 'conversationId must be an integer' });
    }
    const isParticipant = await messagingService.checkConversationMembership(numericConversationId, userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant in this conversation' });
    }

    let historyBuffer;
    try {
      historyBuffer = decodeBase64Field(data, 'data');
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    if (historyBuffer.length > (16 * 1024)) {
      return res.status(413).json({ message: 'history secret too large' });
    }

    const epochValue = epoch === undefined || epoch === null ? null : Number(epoch);
    if (epochValue !== null && !Number.isInteger(epochValue)) {
      return res.status(400).json({ message: 'epoch must be an integer when provided' });
    }

    let record = null;
    try {
      record = await mlsService.insertHistorySecret({
        conversationId: numericConversationId,
        userId,
        senderClientId: senderClientId || null,
        epoch: epochValue,
        secret: historyBuffer
      });
    } catch (persistErr) {
      console.error('Error persisting MLS history secret', persistErr);
      return res.status(500).json({ message: 'Failed to persist history secret' });
    }

    try {
      const participants = await mlsService.getConversationParticipants(numericConversationId);
      const payload = {
        conversationId: numericConversationId,
        senderClientId: senderClientId || null,
        epoch: epochValue,
        data,
        createdAt: record?.created_at ?? new Date().toISOString()
      };
      messagingService.emitToConversationRoom(numericConversationId, 'mls:history-secret', payload);
      messagingService.emitToUsers('mls:history-secret', payload, participants);
    } catch (fanoutErr) {
      console.warn('Failed to fan out MLS history secret', fanoutErr);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error handling MLS history secret:', error);
    return res.status(500).json({ message: 'Failed to process history secret' });
  }
};

exports.migrateConversation = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { conversationId, ciphersuite = DEFAULT_CIPHERSUITE } = req.body || {};
    const numericConversationId = Number(conversationId);
    if (!Number.isInteger(numericConversationId)) {
      return res.status(400).json({ message: 'conversationId must be an integer' });
    }

    const isParticipant = await messagingService.checkConversationMembership(numericConversationId, userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant in this conversation' });
    }

    const cipherInt = Number(ciphersuite);
    if (!Number.isInteger(cipherInt)) {
      return res.status(400).json({ message: 'ciphersuite must be an integer' });
    }

    const updatedConversation = await messagingService.updateConversationEncryption(numericConversationId, {
      mode: 'mls',
      migrationEligible: false
    });

    if (!updatedConversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    try {
      await mlsConversationService.upsertConversation({
        conversationId: numericConversationId,
        creatorUserId: userId,
        ciphersuite: cipherInt
      });
    } catch (svcErr) {
      console.warn('Failed to upsert MLS conversation during migration', svcErr);
    }

    const participants = await mlsService.getConversationParticipants(numericConversationId);
    const payload = {
      conversationId: numericConversationId,
      encryptionMode: 'mls',
      ciphersuite: cipherInt,
      migration: true
    };
    messagingService.emitToConversationRoom(numericConversationId, 'mls:migration', payload);
    messagingService.emitToUsers('mls:migration', payload, participants);

    return res.status(200).json({
      conversationId: updatedConversation.id,
      encryptionMode: updatedConversation.encryption_mode,
      mlsMigrationEligible: updatedConversation.mls_migration_eligible
    });
  } catch (error) {
    console.error('Error migrating conversation to MLS:', error);
    return res.status(500).json({ message: 'Failed to migrate conversation' });
  }
};
