// backend/src/controllers/mlsConversationController.js

const { Buffer } = require('buffer');
const mlsConversationService = require('../services/mlsConversationService');
const messagingService = require('../services/messagingService');

function normalizeUserId(user) {
  if (!user) return null;
  return user.userId ?? user.id ?? null;
}

function ensureParticipant(conversationId, userId) {
  return messagingService.checkConversationMembership(conversationId, userId);
}

exports.upsertConversation = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { conversationId, ciphersuite = 1, groupInfo } = req.body || {};
    const numericId = Number(conversationId);
    if (!Number.isInteger(numericId)) {
      return res.status(400).json({ message: 'conversationId must be an integer' });
    }

    const isParticipant = await ensureParticipant(numericId, userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant in this conversation' });
    }

    const cipherInt = Number(ciphersuite);
    if (!Number.isInteger(cipherInt)) {
      return res.status(400).json({ message: 'ciphersuite must be an integer' });
    }

    let groupInfoBuffer = null;
    if (groupInfo) {
      try {
        groupInfoBuffer = Buffer.from(groupInfo, 'base64');
      } catch {
        return res.status(400).json({ message: 'groupInfo must be base64 encoded' });
      }
    }

    const record = await mlsConversationService.upsertConversation({
      conversationId: numericId,
      creatorUserId: userId,
      ciphersuite: cipherInt,
      groupInfo: groupInfoBuffer
    });

    return res.status(200).json(mapRecord(record));
  } catch (error) {
    console.error('Error upserting MLS conversation:', error);
    return res.status(500).json({ message: 'Failed to upsert MLS conversation' });
  }
};

exports.updateGroupInfo = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const numericId = Number(req.params.conversationId);
    if (!Number.isInteger(numericId)) {
      return res.status(400).json({ message: 'conversationId must be an integer' });
    }

    const isParticipant = await ensureParticipant(numericId, userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant in this conversation' });
    }

    const { groupInfo } = req.body || {};
    if (!groupInfo) {
      return res.status(400).json({ message: 'groupInfo is required (base64)' });
    }

    let buffer;
    try {
      buffer = Buffer.from(groupInfo, 'base64');
    } catch {
      return res.status(400).json({ message: 'groupInfo must be base64 encoded' });
    }

    const record = await mlsConversationService.updateGroupInfo({ conversationId: numericId, groupInfo: buffer });
    if (!record) {
      return res.status(404).json({ message: 'MLS conversation not found' });
    }
    return res.status(200).json(mapRecord(record));
  } catch (error) {
    console.error('Error updating MLS group info:', error);
    return res.status(500).json({ message: 'Failed to update MLS group info' });
  }
};

exports.setHistorySharing = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const numericId = Number(req.params.conversationId);
    if (!Number.isInteger(numericId)) {
      return res.status(400).json({ message: 'conversationId must be an integer' });
    }

    const isParticipant = await ensureParticipant(numericId, userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant in this conversation' });
    }

    const { enabled } = req.body || {};
    const record = await mlsConversationService.setHistorySharing({ conversationId: numericId, enabled: Boolean(enabled) });
    if (!record) {
      return res.status(404).json({ message: 'MLS conversation not found' });
    }
    return res.status(200).json(mapRecord(record));
  } catch (error) {
    console.error('Error updating MLS history sharing:', error);
    return res.status(500).json({ message: 'Failed to update MLS history sharing' });
  }
};

exports.getConversation = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const numericId = Number(req.params.conversationId);
    if (!Number.isInteger(numericId)) {
      return res.status(400).json({ message: 'conversationId must be an integer' });
    }

    const isParticipant = await ensureParticipant(numericId, userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant in this conversation' });
    }

    const record = await mlsConversationService.getConversation(numericId);
    if (!record) {
      return res.status(404).json({ message: 'MLS conversation not found' });
    }
    return res.status(200).json(mapRecord(record));
  } catch (error) {
    console.error('Error fetching MLS conversation:', error);
    return res.status(500).json({ message: 'Failed to fetch MLS conversation' });
  }
};

function mapRecord(record) {
  if (!record) return null;
  return {
    conversationId: record.conversation_id,
    creatorUserId: record.creator_user_id,
    ciphersuite: record.ciphersuite,
    historySharingEnabled: record.history_sharing_enabled,
    groupInfo: record.group_info ? record.group_info.toString('base64') : null,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
}
