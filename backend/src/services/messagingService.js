// backend/src/services/messagingService.js
const db = require('../db');
const notificationService = require('./notificationService');

// Socket.io instance will be injected
let io = null;

/**
 * Set the Socket.io instance for real-time messaging
 * @param {Object} socketIo - Socket.io instance
 */
function setSocketIo(socketIo) {
  io = socketIo;
}

/**
 * Check if a user is a participant in a conversation
 * @param {number} conversationId
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
async function checkConversationMembership(conversationId, userId) {
  try {
    const result = await db.query(
      `SELECT 1 FROM conversations WHERE id = $1 AND (participant_1 = $2 OR participant_2 = $2)`,
      [conversationId, userId]
    );
    return result.rowCount > 0;
  } catch (error) {
    console.error('Error checking conversation membership:', error);
    return false;
  }
}

/**
 * Get or create a conversation between two users
 * @param {number} user1Id - First user ID
 * @param {number} user2Id - Second user ID
 * @returns {Promise<Object>} Conversation record
 */
async function getOrCreateConversation(user1Id, user2Id) {
  try {
    // Use the database function to get or create conversation
    const result = await db.query(
      'SELECT get_or_create_conversation($1, $2) as conversation_id',
      [user1Id, user2Id]
    );

    const conversationId = result.rows[0].conversation_id;

    // Get the full conversation details
    const conversationResult = await db.query(
      `SELECT c.*, u1.username as participant_1_username, u2.username as participant_2_username
       FROM conversations c
       JOIN users u1 ON c.participant_1 = u1.id
       JOIN users u2 ON c.participant_2 = u2.id
       WHERE c.id = $1`,
      [conversationId]
    );

    return conversationResult.rows[0];
  } catch (error) {
    console.error('Error getting/creating conversation:', error);
    throw error;
  }
}

/**
 * Get conversations for a user
 * @param {number} userId - User ID
 * @param {number} limit - Number of conversations to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Object[]>} Array of conversations with metadata
 */
async function getUserConversations(userId, limit = 20, offset = 0) {
  try {
    const result = await db.query(
      `SELECT 
         cs.*,
         CASE 
           WHEN cs.participant_1 = $1 THEN cs.unread_count_participant_1
           ELSE cs.unread_count_participant_2
         END as my_unread_count,
         CASE 
           WHEN cs.participant_1 = $1 THEN cs.participant_2_username
           ELSE cs.participant_1_username
         END as other_user_username,
         CASE 
           WHEN cs.participant_1 = $1 THEN cs.participant_2
           ELSE cs.participant_1
         END as other_user_id
       FROM conversation_summaries cs
       WHERE cs.participant_1 = $1 OR cs.participant_2 = $1
       ORDER BY cs.last_message_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows;
  } catch (error) {
    console.error('Error getting user conversations:', error);
    throw error;
  }
}

/**
 * Send a message in a conversation
 * @param {Object} messageData - Message data
 * @param {number} messageData.conversationId - Conversation ID
 * @param {number} messageData.senderId - Sender user ID
 * @param {number} messageData.receiverId - Receiver user ID
 * @param {string} messageData.encryptedContent - Encrypted message content
 * @param {string} messageData.contentHash - Hash of original content
 * @param {string} messageData.senderSessionKey - Session key encrypted for sender
 * @param {string} messageData.receiverSessionKey - Session key encrypted for receiver
 * @param {string} messageData.messageType - Type of message (text, image, file)
 * @returns {Promise<Object>} Created message record
 */
async function sendMessage({
  conversationId,
  senderId,
  receiverId,
  encryptedContent,
  contentHash,
  senderSessionKey = null,
  receiverSessionKey = null,
  messageType = 'text'
}) {
  try {
    // Verify the sender is part of the conversation and receiver matches the other participant
    const convo = await db.query(
      `SELECT participant_1, participant_2 FROM conversations WHERE id = $1`,
      [conversationId]
    );

    if (convo.rowCount === 0) {
      throw new Error('Conversation not found');
    }

    const { participant_1, participant_2 } = convo.rows[0];
    if (senderId !== participant_1 && senderId !== participant_2) {
      throw new Error('Sender is not part of this conversation');
    }
    const expectedReceiver = senderId === participant_1 ? participant_2 : participant_1;
    if (receiverId !== expectedReceiver) {
      throw new Error('Receiver does not match conversation participants');
    }

    // Insert the message
    const result = await db.query(
      `INSERT INTO messages (
         conversation_id, sender_id, receiver_id, encrypted_content, 
         message_type, sender_session_key, receiver_session_key, content_hash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        conversationId, senderId, receiverId, encryptedContent,
        messageType, senderSessionKey, receiverSessionKey, contentHash
      ]
    );

    const message = result.rows[0];

    // Create delivery record
    await db.query(
      'INSERT INTO message_delivery (message_id) VALUES ($1)',
      [message.id]
    );

    // Emit real-time message if socket.io is available (emit minimal tailored payloads)
    if (io) {
      try {
        // Emit IDs only; clients fetch via authenticated HTTP API
        io.to(`messaging:${receiverId}`).emit('newMessage', {
          messageId: message.id,
          conversationId
        });
        io.to(`messaging:${senderId}`).emit('messageSent', {
          messageId: message.id,
          conversationId
        });

        // Update delivery status
        await db.query(
          'UPDATE message_delivery SET delivered_at = NOW() WHERE message_id = $1',
          [message.id]
        );
      } catch (socketError) {
        console.error('Error emitting real-time message:', socketError);
        // Don't fail the message sending if socket emission fails
      }
    }

    // Create notification for receiver
    try {
      const senderResult = await db.query(
        'SELECT username FROM users WHERE id = $1',
        [senderId]
      );
      
      await notificationService.createNotification({
        userId: receiverId,
        type: 'message',
        actorId: senderId,
        targetId: message.id,
        targetType: 'message',
        content: `${senderResult.rows[0]?.username || 'Someone'} sent you a message`
      });
    } catch (notificationError) {
      console.error('Error creating message notification:', notificationError);
      // Don't fail message sending if notification fails
    }

    return message;
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
}

/**
 * Get messages in a conversation
 * @param {number} conversationId - Conversation ID
 * @param {number} userId - User ID (for authorization)
 * @param {number} limit - Number of messages to return
 * @param {number} offset - Offset for pagination
 * @param {Date} before - Get messages before this date
 * @returns {Promise<Object[]>} Array of messages
 */
async function getConversationMessages(conversationId, userId, limit = 50, offset = 0, before = null) {
  try {
    // Verify user is part of the conversation
    const conversationCheck = await db.query(
      `SELECT id FROM conversations 
       WHERE id = $1 AND (participant_1 = $2 OR participant_2 = $2)`,
      [conversationId, userId]
    );

    if (conversationCheck.rows.length === 0) {
      throw new Error('User is not part of this conversation');
    }

    let query = `
      SELECT m.*, u.username as sender_username,
             md.delivered_at, md.delivery_attempts
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN message_delivery md ON m.id = md.message_id
      WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
    `;
    
    const params = [conversationId];
    let paramCount = 1;

    if (before) {
      paramCount++;
      query += ` AND m.created_at < $${paramCount}`;
      params.push(before);
    }

    paramCount++;
    query += ` ORDER BY m.created_at DESC LIMIT $${paramCount}`;
    params.push(limit);

    paramCount++;
    query += ` OFFSET $${paramCount}`;
    params.push(offset);

    const result = await db.query(query, params);
    
    // Return messages in chronological order (oldest first)
    return result.rows.reverse();
  } catch (error) {
    console.error('Error getting conversation messages:', error);
    throw error;
  }
}

/**
 * Mark messages as read
 * @param {number[]} messageIds - Array of message IDs to mark as read
 * @param {number} userId - User ID (must be the receiver of the messages)
 * @returns {Promise<number>} Number of messages marked as read
 */
async function markMessagesAsRead(messageIds, userId) {
  try {
    if (!messageIds || messageIds.length === 0) {
      return 0;
    }

    const result = await db.query(
      `UPDATE messages 
       SET read_at = NOW() 
       WHERE id = ANY($1::int[]) 
       AND receiver_id = $2 
       AND read_at IS NULL
       RETURNING id, sender_id, conversation_id`,
      [messageIds, userId]
    );

    const updatedMessages = result.rows;

    // Emit read receipts to senders via socket
    if (io && updatedMessages.length > 0) {
      try {
        // Group by sender to minimize socket emissions
        const bySender = updatedMessages.reduce((acc, msg) => {
          if (!acc[msg.sender_id]) {
            acc[msg.sender_id] = [];
          }
          acc[msg.sender_id].push({
            messageId: msg.id,
            conversationId: msg.conversation_id,
            readAt: new Date().toISOString(),
            readBy: userId
          });
          return acc;
        }, {});

        // Emit to each sender
        Object.entries(bySender).forEach(([senderId, readReceipts]) => {
          io.to(`user:${senderId}`).emit('messagesRead', {
            readReceipts,
            readBy: userId
          });
        });
      } catch (socketError) {
        console.error('Error emitting read receipts:', socketError);
      }
    }

    return result.rowCount;
  } catch (error) {
    console.error('Error marking messages as read:', error);
    throw error;
  }
}

/**
 * Get unread message count for a user
 * @param {number} userId - User ID
 * @returns {Promise<number>} Number of unread messages
 */
async function getUnreadMessageCount(userId) {
  try {
    const result = await db.query(
      `SELECT COUNT(*) as count 
       FROM messages 
       WHERE receiver_id = $1 AND read_at IS NULL AND deleted_at IS NULL`,
      [userId]
    );

    return parseInt(result.rows[0].count, 10);
  } catch (error) {
    console.error('Error getting unread message count:', error);
    throw error;
  }
}

/**
 * Delete a message (soft delete)
 * @param {number} messageId - Message ID
 * @param {number} userId - User ID (must be sender of the message)
 * @returns {Promise<boolean>} True if message was deleted
 */
async function deleteMessage(messageId, userId) {
  try {
    const result = await db.query(
      `UPDATE messages 
       SET deleted_at = NOW() 
       WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL`,
      [messageId, userId]
    );

    if (result.rowCount > 0 && io) {
      // Emit message deletion to all participants
      const messageResult = await db.query(
        'SELECT conversation_id, receiver_id FROM messages WHERE id = $1',
        [messageId]
      );
      
      if (messageResult.rows.length > 0) {
        const { conversation_id, receiver_id } = messageResult.rows[0];
        
        // Emit to both sender and receiver
        io.to(`user:${userId}`).emit('messageDeleted', { messageId, conversationId: conversation_id });
        io.to(`user:${receiver_id}`).emit('messageDeleted', { messageId, conversationId: conversation_id });
      }
    }

    return result.rowCount > 0;
  } catch (error) {
    console.error('Error deleting message:', error);
    throw error;
  }
}

/**
 * Get conversation by ID (with authorization check)
 * @param {number} conversationId - Conversation ID
 * @param {number} userId - User ID (for authorization)
 * @returns {Promise<Object|null>} Conversation record or null
 */
async function getConversation(conversationId, userId) {
  try {
    const result = await db.query(
      `SELECT c.*, u1.username as participant_1_username, u2.username as participant_2_username
       FROM conversations c
       JOIN users u1 ON c.participant_1 = u1.id
       JOIN users u2 ON c.participant_2 = u2.id
       WHERE c.id = $1 AND (c.participant_1 = $2 OR c.participant_2 = $2)`,
      [conversationId, userId]
    );

    return result.rows[0] || null;
  } catch (error) {
    console.error('Error getting conversation:', error);
    throw error;
  }
}

/**
 * Search conversations by username
 * @param {number} userId - User ID
 * @param {string} searchTerm - Username search term
 * @param {number} limit - Maximum results
 * @returns {Promise<Object[]>} Matching conversations
 */
async function searchConversations(userId, searchTerm, limit = 10) {
  try {
    const result = await db.query(
      `SELECT 
         cs.*,
         CASE 
           WHEN cs.participant_1 = $1 THEN cs.unread_count_participant_1
           ELSE cs.unread_count_participant_2
         END as my_unread_count,
         CASE 
           WHEN cs.participant_1 = $1 THEN cs.participant_2_username
           ELSE cs.participant_1_username
         END as other_user_username,
         CASE 
           WHEN cs.participant_1 = $1 THEN cs.participant_2
           ELSE cs.participant_1
         END as other_user_id
       FROM conversation_summaries cs
       WHERE (cs.participant_1 = $1 OR cs.participant_2 = $1)
       AND (
         cs.participant_1_username ILIKE $2 OR 
         cs.participant_2_username ILIKE $2
       )
       ORDER BY cs.last_message_at DESC
       LIMIT $3`,
      [userId, `%${searchTerm}%`, limit]
    );

    return result.rows;
  } catch (error) {
    console.error('Error searching conversations:', error);
    throw error;
  }
}

module.exports = {
  setSocketIo,
  checkConversationMembership,
  getOrCreateConversation,
  getUserConversations,
  sendMessage,
  getConversationMessages,
  markMessagesAsRead,
  getUnreadMessageCount,
  deleteMessage,
  getConversation,
  searchConversations
};