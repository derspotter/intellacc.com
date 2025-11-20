// frontend/src/services/messaging.js
// Frontend messaging service for end-to-end encrypted messaging

import api from './api.js';
import keyManager from './keyManager.js';
import socketService from './socket.js';
import messagingStore from '../stores/messagingStore.js';
// No pairKey work in service; store normalizes

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
        const applyMessageEvent = async (conversationId, { createdAt = null, isSelected = false } = {}) => {
            try {
                if (isSelected) {
                    const response = await api.messages.getMessages(conversationId, 50, 0);
                    const decryptedMessages = await this.decryptMessages(response.messages);
                    messagingStore.setMessages(conversationId, decryptedMessages);
                } else {
                    messagingStore.incrementUnread(conversationId, 1);
                    const ts = createdAt || new Date().toISOString();
                    messagingStore.updateConversation(conversationId, { last_message_created_at: ts });
                }
            } catch (error) {
                // swallow socket event errors; list will reconcile on next fetch
            }
        };
        // Listen for new messages (IDs-only strategy: fetch recent window)
        socketService.on('newMessage', async (data) => {
            const { conversationId, created_at } = data || {};
            if (!conversationId) return;
            const isSelected = (messagingStore.selectedConversationId === String(conversationId));
            await applyMessageEvent(conversationId, { createdAt: created_at, isSelected });
        });

        // Listen for message sent confirmations: refresh recent window if open
        socketService.on('messageSent', async (data) => {
            const { conversationId, created_at } = data || {};
            if (!conversationId) return;
            const isSelected = (messagingStore.selectedConversationId === String(conversationId));
            if (isSelected) {
                const response = await api.messages.getMessages(conversationId, 50, 0);
                const decryptedMessages = await this.decryptMessages(response.messages);
                messagingStore.setMessages(conversationId, decryptedMessages);
            } else {
                const ts = created_at || new Date().toISOString();
                messagingStore.updateConversation(conversationId, { last_message_created_at: ts });
            }
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
     * Create or get conversation with another user
     * @param {number|null} otherUserId - User ID (for backwards compatibility)
     * @param {string|null} otherUsername - Username (preferred method)
     */
    async createConversation(otherUserId, otherUsername) {
        try {
            const response = await api.messages.createConversation(otherUserId, otherUsername);

            // Add conversation to store
            messagingStore.addConversation(response.conversation);

            return response.conversation;
        } catch (error) {
            console.error('Error creating conversation:', error);
            throw error;
        }
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
                socketService.emit('join-messaging');

                // Also listen for when socket connects to ensure we join
                socketService.on('connect', () => {
                    console.log(`Socket connected, ensuring messaging room join for user ${userData.userId}`);
                    socketService.emit('join-messaging');
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
     * Ensure a conversation exists in the store; fetch from API if missing
     */
    async ensureConversation(conversationId) {
        const idStr = String(conversationId);
        const existing = (messagingStore.conversations || []).find(c => String(c.id) === idStr);
        if (existing) return existing;
        try {
            const resp = await api.messages.getConversation(conversationId);
            const conv = resp?.conversation;
            if (!conv) return null;
            messagingStore.upsertConversation(conv);
            return messagingStore.conversationsById?.[String(conv.conversation_id ?? conv.id)] || conv;
        } catch (e) {
            console.error('ensureConversation error:', e);
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
            const rawList = response.conversations || [];

            // store handles normalization

            // Update store with conversations (store normalizes/dedupes)
            messagingStore.upsertConversations(rawList);

            return messagingStore.conversations;
        } catch (error) {
            console.error('Error getting conversations:', error);
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

            const response = await api.messages.sendMessage(conversationId, {
                encryptedContent: encryptedData.encryptedContent,
                receiverId: receiverId,
                contentHash: encryptedData.contentHash,
                receiverSessionKey: encryptedData.encryptedSessionKey,
                senderSessionKey: encryptedData.senderSessionKey || null,
                messageType: messageType
            });

            // Optimistic UI: insert the just-sent message immediately.
            // Store includes de-duplicator by message ID; socket refresh will reconcile.
            try {
                const userData = this.getUserData();
                const optimistic = {
                    id: response?.message?.id || Date.now(),
                    conversation_id: conversationId,
                    sender_id: userData?.userId,
                    receiver_id: receiverId,
                    encrypted_content: encryptedData.encryptedContent,
                    sender_session_key: encryptedData.senderSessionKey || null,
                    receiver_session_key: encryptedData.encryptedSessionKey,
                    created_at: new Date().toISOString(),
                    read_at: null,
                    decryptedContent: message,
                    isDecrypted: true
                };
                messagingStore.addMessage(conversationId, optimistic);
            } catch (optErr) {
                console.warn('Optimistic insert skipped:', optErr?.message || optErr);
            }

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

                const myId = userData ? Number(userData.userId) : NaN;
                const senderId = Number(message.sender_id);
                let sessionKey = (senderId === myId)
                    ? message.sender_session_key
                    : message.receiver_session_key;

                if (sessionKey) {
                    let decryptedContent;
                    try {
                        decryptedContent = await keyManager.decryptMessage(
                            message.encrypted_content,
                            sessionKey
                        );
                    } catch (primaryErr) {
                        // Fallback: try the opposite session key in case of sender/receiver mismatch
                        const altKey = (sessionKey === message.sender_session_key)
                            ? message.receiver_session_key
                            : message.sender_session_key;
                        if (altKey) {
                            try {
                                decryptedContent = await keyManager.decryptMessage(
                                    message.encrypted_content,
                                    altKey
                                );
                            } catch (altErr) {
                                throw altErr;
                            }
                        } else {
                            throw primaryErr;
                        }
                    }

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
            } else {
                // already exists; no update needed
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


    }

    /**
     * Handle message deletion
     */
    handleMessageDeleted(data) {
        const { messageId, conversationId } = data;

        // Remove from store
        messagingStore.removeMessage(messageId);
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
    }

    /**
     * Send typing indicator
     */
    sendTypingIndicator(conversationId, isTyping) {
        const userData = this.getUserData();
        if (!userData) return;

        const event = isTyping ? 'typing-start' : 'typing-stop';
        if (socketService.state.connected.val) {
            socketService.emit(event, { conversationId, userId: userData.userId });
        } else {
            // Defer until connected
            socketService.on('connect', () => socketService.emit(event, { conversationId, userId: userData.userId }));
        }
    }

    /**
     * Join conversation room for typing indicators
    */
    joinConversation(conversationId) {
        if (socketService.state.connected.val) {
            socketService.emit('join-conversation', conversationId);
        } else {
            // Ensure we join after connection
            socketService.on('connect', () => socketService.emit('join-conversation', conversationId));
        }
    }

    /**
     * Leave conversation room
     */
    leaveConversation(conversationId) {
        if (socketService.state.connected.val) {
            socketService.emit('leave-conversation', conversationId);
        } else {
            // If not connected, nothing to leave; on next connect we'll join fresh as needed
        }
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
