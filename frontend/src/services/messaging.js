// frontend/src/services/messaging.js
// Frontend messaging service for end-to-end encrypted messaging

import api from './api.js';
import keyManager from './keyManager.js';
import socketService from './socket.js';
import messagingStore from '../stores/messagingStore.js';

/**
 * Messaging service for handling encrypted conversations and messages
 */
class MessagingService {
  constructor() {
    this.setupSocketHandlers();
  }

  /**
   * Setup Socket.io handlers for real-time messaging
   */
  setupSocketHandlers() {
    // Listen for new messages
    socketService.on('newMessage', (data) => {
      this.handleNewMessage(data);
    });

    // Listen for message sent confirmations
    socketService.on('messageSent', (data) => {
      this.handleMessageSent(data);
    });

    // Listen for read receipts
    socketService.on('messagesRead', (data) => {
      this.handleMessagesRead(data);
    });

    // Listen for message deletions
    socketService.on('messageDeleted', (data) => {
      this.handleMessageDeleted(data);
    });

    // Listen for typing indicators
    socketService.on('user-typing', (data) => {
      this.handleTypingIndicator(data);
    });
  }

  /**
   * Initialize messaging service
   */
  async initialize() {
    try {
      // Initialize key manager first
      await keyManager.initialize();
      
      // Ensure user has encryption keys
      await keyManager.ensureKeys();
      
      // Join messaging room for real-time updates (wait for socket connection)
      const userData = this.getUserData();
      if (userData && userData.userId) {
        console.log(`Joining messaging room for user ${userData.userId}`);
        
        // Try to join immediately, if socket not connected it will queue the emit
        socketService.emit('join-messaging', userData.userId);
        
        // Also listen for when socket connects to ensure we join
        socketService.on('connect', () => {
          console.log(`Socket connected, ensuring messaging room join for user ${userData.userId}`);
          socketService.emit('join-messaging', userData.userId);
        });
      }
      
      console.log('Messaging service initialized');
    } catch (error) {
      console.error('Error initializing messaging service:', error);
      throw error;
    }
  }

  /**
   * Get user data from token (similar to auth service)
   */
  getUserData() {
    try {
      const token = localStorage.getItem('token');
      if (!token) return null;
      
      const payload = JSON.parse(atob(token.split('.')[1]));
      return { userId: payload.userId, username: payload.username };
    } catch (error) {
      return null;
    }
  }

  /**
   * Get conversations for current user
   */
  async getConversations(limit = 20, offset = 0) {
    try {
      const response = await api.messages.getConversations(limit, offset);
      
      // Normalize conversation field names (conversation_id -> id)
      const normalizedConversations = response.conversations.map(conv => ({
        ...conv,
        id: conv.conversation_id
      }));
      
      // Update store with conversations
      messagingStore.setConversations(normalizedConversations);
      
      return normalizedConversations;
    } catch (error) {
      console.error('Error getting conversations:', error);
      throw error;
    }
  }

  /**
   * Create or get conversation with another user
   */
  async createConversation(otherUserId) {
    try {
      const response = await api.messages.createConversation(otherUserId);
      
      // Add conversation to store
      messagingStore.addConversation(response.conversation);
      
      return response.conversation;
    } catch (error) {
      console.error('Error creating conversation:', error);
      throw error;
    }
  }

  /**
   * Get messages in a conversation
   */
  async getMessages(conversationId, limit = 50, offset = 0, before = null) {
    try {
      const response = await api.messages.getMessages(conversationId, limit, offset, before);
      
      // Decrypt messages
      const decryptedMessages = await this.decryptMessages(response.messages);
      
      if (offset === 0) {
        // Replace if getting latest messages
        messagingStore.setMessages(conversationId, decryptedMessages);
      } else {
        // Append older messages
        for (const message of decryptedMessages) {
          messagingStore.addMessage(conversationId, message);
        }
      }
      
      return decryptedMessages;
    } catch (error) {
      console.error('Error getting messages:', error);
      throw error;
    }
  }

  /**
   * Send an encrypted message
   */
  async sendMessage(conversationId, receiverId, message, messageType = 'text') {
    try {
      // Encrypt the message
      const encryptedData = await keyManager.encryptMessage(message, receiverId);
      
      console.log('Sending message to API:', { conversationId, receiverId });
      
      const response = await api.messages.sendMessage(conversationId, {
        encryptedContent: encryptedData.encryptedContent,
        receiverId: receiverId,
        contentHash: encryptedData.contentHash,
        receiverSessionKey: encryptedData.encryptedSessionKey,
        senderSessionKey: encryptedData.senderSessionKey || null,
        messageType: messageType
      });
      
      console.log('Message sent successfully:', response);
      
      // Don't add to cache here - wait for socket event to avoid duplicates
      // The messageSent socket event will handle adding it to the UI
      
      return response.message;
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }

  /**
   * Mark messages as read
   */
  async markMessagesAsRead(messageIds) {
    try {
      const response = await api.messages.markAsRead(messageIds);
      
      // Update store
      messagingStore.markMessagesAsRead(messageIds);
      
      return response;
    } catch (error) {
      console.error('Error marking messages as read:', error);
      throw error;
    }
  }

  /**
   * Get unread message count
   */
  async getUnreadCount() {
    try {
      const response = await api.messages.getUnreadCount();
      return response.count;
    } catch (error) {
      console.error('Error getting unread count:', error);
      throw error;
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(messageId) {
    try {
      const response = await api.messages.deleteMessage(messageId);
      
      // Remove from store
      messagingStore.removeMessage(messageId);
      
      return response;
    } catch (error) {
      console.error('Error deleting message:', error);
      throw error;
    }
  }

  /**
   * Search conversations
   */
  async searchConversations(query, limit = 10) {
    try {
      const response = await api.messages.searchConversations(query, limit);
      return response.conversations;
    } catch (error) {
      console.error('Error searching conversations:', error);
      throw error;
    }
  }

  /**
   * Decrypt array of encrypted messages
   */
  async decryptMessages(encryptedMessages) {
    const decryptedMessages = [];
    
    for (const message of encryptedMessages) {
      try {
        // Determine which session key to use based on user role
        const userData = this.getUserData();
        
        const sessionKey = message.sender_id === userData.userId 
          ? message.sender_session_key 
          : message.receiver_session_key;
        
        if (sessionKey) {
          const decryptedContent = await keyManager.decryptMessage(
            message.encrypted_content,
            sessionKey
          );
          
          decryptedMessages.push({
            ...message,
            decryptedContent: decryptedContent,
            isDecrypted: true
          });
        } else {
          // Messages without valid session keys are permanently lost due to key regeneration
          decryptedMessages.push({
            ...message,
            decryptedContent: '[Message encrypted with old keys - unable to decrypt]',
            isDecrypted: false
          });
        }
      } catch (error) {
        console.error('Error decrypting message:', message.id, error);
        decryptedMessages.push({
          ...message,
          decryptedContent: '[Encrypted message - decryption failed]',
          isDecrypted: false
        });
      }
    }
    
    return decryptedMessages;
  }

  /**
   * Handle new incoming message from socket
   */
  async handleNewMessage(messageData) {
    try {
      console.log('Handling new message:', messageData);
      
      // Decrypt the message
      const decryptedMessages = await this.decryptMessages([messageData]);
      const decryptedMessage = decryptedMessages[0];
      
      // Add to store (built-in deduplication)
      const added = messagingStore.addMessage(messageData.conversation_id, decryptedMessage);
      
      if (added) {
        // Update conversation in store
        messagingStore.updateConversation(messageData.conversation_id, {
          last_message_created_at: decryptedMessage.created_at,
          last_message_encrypted: decryptedMessage.encrypted_content,
          last_message_sender_id: decryptedMessage.sender_id
        });
        
        console.log('New message added to store and will trigger reactive UI update');
      }
    } catch (error) {
      console.error('Error handling new message:', error);
    }
  }

  /**
   * Handle message sent confirmation
   */
  async handleMessageSent(messageData) {
    try {
      console.log('Handling messageSent event:', messageData);
      
      // Decrypt the message
      const decryptedMessages = await this.decryptMessages([messageData]);
      const decryptedMessage = decryptedMessages[0];
      
      console.log('Decrypted sent message:', decryptedMessage);
      
      // Add to store (built-in deduplication)
      const added = messagingStore.addMessage(messageData.conversation_id, decryptedMessage);
      
      if (added) {
        // Update conversation in store
        messagingStore.updateConversation(messageData.conversation_id, {
          last_message_created_at: decryptedMessage.created_at,
          last_message_encrypted: decryptedMessage.encrypted_content,
          last_message_sender_id: decryptedMessage.sender_id
        });
        
        console.log('Sent message added to store and will trigger reactive UI update');
      } else {
        console.log('Sent message already exists in store, no UI update needed');
      }
      
    } catch (error) {
      console.error('Error handling sent message:', error);
    }
  }

  /**
   * Handle read receipts
   */
  handleMessagesRead(data) {
    const { readReceipts, readBy } = data;
    
    for (const receipt of readReceipts) {
      // Update message in store
      messagingStore.updateMessage(receipt.messageId, {
        read_at: receipt.readAt,
        read_by: readBy
      });
    }
    
    console.log('Read receipts updated in store');
  }

  /**
   * Handle message deletion
   */
  handleMessageDeleted(data) {
    const { messageId, conversationId } = data;
    
    // Remove from store
    messagingStore.removeMessage(messageId);
    
    console.log(`Message ${messageId} deleted from store`);
  }

  /**
   * Handle typing indicators
   */
  handleTypingIndicator(data) {
    const { userId, isTyping } = data;
    
    if (isTyping) {
      messagingStore.addTypingUser(userId);
    } else {
      messagingStore.removeTypingUser(userId);
    }
    
    console.log('Typing indicator updated in store');
  }

  /**
   * Send typing indicator
   */
  sendTypingIndicator(conversationId, isTyping) {
    const userData = this.getUserData();
    if (!userData) return;
    
    const event = isTyping ? 'typing-start' : 'typing-stop';
    socketService.emit(event, {
      conversationId: conversationId,
      userId: userData.userId
    });
  }

  /**
   * Join conversation room for typing indicators
   */
  joinConversation(conversationId) {
    socketService.emit('join-conversation', conversationId);
  }

  /**
   * Leave conversation room
   */
  leaveConversation(conversationId) {
    socketService.emit('leave-conversation', conversationId);
  }

  /**
   * Clear all cached data - now delegates to store
   */
  clearCache() {
    messagingStore.clearCache();
  }
}

// Create singleton instance
const messagingService = new MessagingService();

export default messagingService;