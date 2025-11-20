// backend/src/controllers/messagingController.js
const messagingService = require('../services/messagingService');
const keyManagementService = require('../services/keyManagementService');
const db = require('../db');

/**
 * Get user's conversations
 * GET /api/messages/conversations
 */
async function getConversations(req, res) {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100); // Max 100
    const offset = parseInt(req.query.offset) || 0;
    
    const conversations = await messagingService.getUserConversations(userId, limit, offset);
    
    res.json({
      conversations,
      pagination: {
        limit,
        offset,
        hasMore: conversations.length === limit
      }
    });
  } catch (error) {
    console.error('Error getting conversations:', error);
    res.status(500).json({ 
      error: 'Failed to get conversations' 
    });
  }
}

/**
 * Get or create a conversation with another user
 * POST /api/messages/conversations
 * Accepts either otherUsername or otherUserId (for backwards compatibility)
 */
async function createConversation(req, res) {
  try {
    const { otherUsername, otherUserId } = req.body;
    const userId = req.user.id;
    let targetUserId;

    // Handle username-based conversation creation
    if (otherUsername) {
      // Look up user by username
      const userResult = await db.query(
        'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)',
        [otherUsername.trim()]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({ 
          error: `User "${otherUsername}" not found` 
        });
      }

      targetUserId = userResult.rows[0].id;
    } 
    // Fallback to userId for backwards compatibility
    else if (otherUserId) {
      if (isNaN(parseInt(otherUserId))) {
        return res.status(400).json({ 
          error: 'Valid otherUserId is required' 
        });
      }
      targetUserId = parseInt(otherUserId);
    } 
    else {
      return res.status(400).json({ 
        error: 'Either otherUsername or otherUserId is required' 
      });
    }

    // Prevent conversation with self
    if (targetUserId === userId) {
      return res.status(400).json({ 
        error: 'Cannot create conversation with yourself' 
      });
    }

    // Check if both users have public keys (required for encryption)
    const [myKey, otherKey] = await Promise.all([
      keyManagementService.getUserPublicKey(userId),
      keyManagementService.getUserPublicKey(targetUserId)
    ]);

    if (!myKey) {
      return res.status(400).json({ 
        error: 'You must have a public key to start conversations' 
      });
    }

    if (!otherKey) {
      return res.status(400).json({ 
        error: 'The other user must have a public key to receive messages' 
      });
    }

    const conversation = await messagingService.getOrCreateConversation(userId, targetUserId);
    
    res.json({ conversation });
  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ 
      error: 'Failed to create conversation' 
    });
  }
}

/**
 * Get messages in a conversation
 * GET /api/messages/conversations/:conversationId/messages
 */
async function getMessages(req, res) {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100
    const offset = parseInt(req.query.offset) || 0;
    const before = req.query.before ? new Date(req.query.before) : null;

    if (!conversationId || isNaN(parseInt(conversationId))) {
      return res.status(400).json({ 
        error: 'Valid conversation ID is required' 
      });
    }

    const messages = await messagingService.getConversationMessages(
      parseInt(conversationId), 
      userId, 
      limit, 
      offset, 
      before
    );
    
    res.json({
      messages,
      pagination: {
        limit,
        offset,
        hasMore: messages.length === limit
      }
    });
  } catch (error) {
    console.error('Error getting messages:', error);
    if (error.message === 'User is not part of this conversation') {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ 
      error: 'Failed to get messages' 
    });
  }
}

/**
 * Send a message
 * POST /api/messages/conversations/:conversationId/messages
 */
async function sendMessage(req, res) {
try {
const { conversationId } = req.params;
const userId = req.user.id;
const {
encryptedContent,
receiverId: receiverIdRaw,
receiverUsername,
contentHash,
senderSessionKey,
receiverSessionKey,
messageType = 'text'
} = req.body;

    // Enforce maximum payload size (~16KB base64 ≈ 12KB raw)
    try {
      const maxBase64Bytes = 16 * 1024; // 16KB
      const size = typeof encryptedContent === 'string' ? Buffer.byteLength(encryptedContent, 'utf8') : 0;
      if (!encryptedContent || size === 0) {
        return res.status(400).json({ error: 'encryptedContent is required' });
      }
      if (size > maxBase64Bytes) {
        return res.status(400).json({ error: 'Message too large' });
      }
    } catch (_) {
      return res.status(400).json({ error: 'Invalid encryptedContent' });
    }

    if (!conversationId || isNaN(parseInt(conversationId))) {
      return res.status(400).json({ 
        error: 'Valid conversation ID is required' 
      });
    }

    if (!encryptedContent || !contentHash) {
      return res.status(400).json({ error: 'encryptedContent and contentHash are required' });
    }

    // Determine receiverId: prefer explicit receiverId, else receiverUsername, else derive from conversation
    let receiverId = undefined;
    if (receiverIdRaw != null) {
      if (isNaN(parseInt(receiverIdRaw))) {
        return res.status(400).json({ error: 'Valid receiverId is required' });
      }
      receiverId = parseInt(receiverIdRaw);
    } else if (receiverUsername && typeof receiverUsername === 'string') {
      const ru = await db.query('SELECT id FROM users WHERE username = $1', [receiverUsername]);
      if (ru.rowCount === 0) {
        return res.status(404).json({ error: 'Receiver not found' });
      }
      receiverId = ru.rows[0].id;
    } else {
      // Derive from conversation participants
      const convo = await db.query('SELECT participant_1, participant_2 FROM conversations WHERE id = $1', [parseInt(conversationId)]);
      if (convo.rowCount === 0) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      const { participant_1, participant_2 } = convo.rows[0];
      receiverId = (userId === participant_1) ? participant_2 : participant_1;
    }

    // Validate message type
    const validTypes = ['text', 'image', 'file'];
    if (!validTypes.includes(messageType)) {
      return res.status(400).json({ 
        error: 'Invalid message type' 
      });
    }

    // Validate content hash format (should be SHA-256 hex)
    if (!/^[a-fA-F0-9]{64}$/.test(contentHash)) {
      return res.status(400).json({ 
        error: 'Invalid content hash format' 
      });
    }

    const message = await messagingService.sendMessage({
      conversationId: parseInt(conversationId),
      senderId: userId,
      receiverId: parseInt(receiverId),
      encryptedContent,
      contentHash,
      senderSessionKey,
      receiverSessionKey,
      messageType
    });
    
    res.status(201).json({ 
      message: {
        id: message.id,
        conversationId: message.conversation_id,
        senderId: message.sender_id,
        receiverId: message.receiver_id,
        encryptedContent: message.encrypted_content,
        messageType: message.message_type,
        contentHash: message.content_hash,
        createdAt: message.created_at,
        readAt: message.read_at
      }
    });
  } catch (error) {
    console.error('Error sending message:', error);
    if (error.message === 'Sender is not part of this conversation') {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ 
      error: 'Failed to send message' 
    });
  }
}

/**
 * Mark messages as read
 * POST /api/messages/read
 */
async function markAsRead(req, res) {
  try {
    const { messageIds } = req.body;
    const userId = req.user.id;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ 
        error: 'messageIds must be a non-empty array' 
      });
    }

    // Validate all messageIds are numbers
    const validMessageIds = messageIds.filter(id => !isNaN(parseInt(id))).map(id => parseInt(id));
    
    if (validMessageIds.length === 0) {
      return res.status(400).json({ 
        error: 'No valid message IDs provided' 
      });
    }

    const updatedCount = await messagingService.markMessagesAsRead(validMessageIds, userId);
    
    res.json({ 
      success: true,
      markedAsRead: updatedCount
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ 
      error: 'Failed to mark messages as read' 
    });
  }
}

/**
 * Get unread message count
 * GET /api/messages/unread-count
 */
async function getUnreadCount(req, res) {
  try {
    const userId = req.user.id;
    
    const count = await messagingService.getUnreadMessageCount(userId);
    
    res.json({ count });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ 
      error: 'Failed to get unread count' 
    });
  }
}

/**
 * Delete a message
 * DELETE /api/messages/:messageId
 */
async function deleteMessage(req, res) {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    if (!messageId || isNaN(parseInt(messageId))) {
      return res.status(400).json({ 
        error: 'Valid message ID is required' 
      });
    }

    const deleted = await messagingService.deleteMessage(parseInt(messageId), userId);
    
    if (!deleted) {
      return res.status(404).json({ 
        error: 'Message not found or you are not authorized to delete it' 
      });
    }

    res.json({ 
      success: true,
      message: 'Message deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ 
      error: 'Failed to delete message' 
    });
  }
}

/**
 * Search conversations
 * GET /api/messages/conversations/search
 */
async function searchConversations(req, res) {
  try {
    const userId = req.user.id;
    const { q } = req.query; // search query
    const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Max 50

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Search query is required' 
      });
    }

    const conversations = await messagingService.searchConversations(userId, q.trim(), limit);
    
    res.json({ 
      conversations,
      query: q.trim()
    });
  } catch (error) {
    console.error('Error searching conversations:', error);
    res.status(500).json({ 
      error: 'Failed to search conversations' 
    });
  }
}

/**
 * Get conversation details by ID
 * GET /api/messages/conversations/:conversationId
 */
async function getConversation(req, res) {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    if (!conversationId || isNaN(parseInt(conversationId))) {
      return res.status(400).json({ 
        error: 'Valid conversation ID is required' 
      });
    }

    const conversation = await messagingService.getConversation(parseInt(conversationId), userId);
    
    if (!conversation) {
      return res.status(404).json({ 
        error: 'Conversation not found or you are not authorized to view it' 
      });
    }

    res.json({ conversation });
  } catch (error) {
    console.error('Error getting conversation:', error);
    res.status(500).json({ 
      error: 'Failed to get conversation' 
    });
  }
}

module.exports = {
  getConversations,
  createConversation,
  getMessages,
  sendMessage,
  markAsRead,
  getUnreadCount,
  deleteMessage,
  searchConversations,
  getConversation
};
