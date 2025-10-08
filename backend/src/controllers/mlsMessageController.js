// backend/src/controllers/mlsMessageController.js

const mlsService = require('../services/mlsService');
const messagingService = require('../services/messagingService');

function normalizeUserId(user) {
  if (!user) return null;
  return user.userId ?? user.id ?? null;
}

exports.listMessages = async (req, res) => {
  try {
    const userId = normalizeUserId(req.user);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const conversationId = Number(req.params.conversationId);
    if (!Number.isInteger(conversationId)) {
      return res.status(400).json({ message: 'conversationId must be an integer' });
    }

    const isParticipant = await messagingService.checkConversationMembership(conversationId, userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant in this conversation' });
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = req.query.before ? new Date(req.query.before) : null;

    const rows = await mlsService.listApplicationMessages(conversationId, userId, limit, before);

    const items = rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      senderUserId: row.user_id,
      senderClientId: row.sender_client_id,
      epoch: row.epoch,
      ciphertext: row.ciphertext.toString('base64'),
      createdAt: row.created_at
    }));

    return res.status(200).json({ items });
  } catch (error) {
    console.error('Error fetching MLS messages:', error);
    return res.status(500).json({ message: 'Failed to fetch MLS messages' });
  }
};
