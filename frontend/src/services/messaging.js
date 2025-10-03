// frontend/src/services/messaging.js
// Frontend messaging service for end-to-end encrypted messaging

import api from './api.js';
import keyManager from './keyManager.js';
import socketService from './socket.js';
import messagingStore from '../stores/messagingStore.js';
import cryptoService from './crypto.js';
import signalAdapter from './signalAdapter.js';
import { getTokenData } from './auth.js';
// No pairKey work in service; store normalizes

/**
 * Messaging service for handling encrypted conversations and messages
 */
class MessagingService {
    constructor() {
        this._connectHandlerAdded = false;
        this.setupSocketHandlers();
    }

    // Generate a compact clientId for optimistic sends
    _generateClientId() {
        try {
            const rand = new Uint8Array(8);
            window.crypto.getRandomValues(rand);
            const hex = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
            return `${Date.now().toString(36)}-${hex}`;
        } catch {
            return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        }
    }

    /**
     * Setup Socket.io handlers for real-time messaging
     */
    setupSocketHandlers() {
        const applyMessageEvent = async (conversationId, { createdAt = null, isSelected = false, incrementUnread = true } = {}) => {
            try {
                if (isSelected) {
                    const response = await api.messages.getMessages(conversationId, 50, 0);
                    const decryptedMessages = await this.decryptMessages(response.messages);
                    messagingStore.setMessages(conversationId, decryptedMessages);
                } else {
                    if (incrementUnread) {
                        messagingStore.incrementUnread(conversationId, 1);
                    }
                    const ts = createdAt || new Date().toISOString();
                    messagingStore.updateConversation(conversationId, { last_message_created_at: ts });
                }
            } catch (error) {
                // swallow socket event errors; list will reconcile on next fetch
            }
        };

        const handleSocketMessageEnvelope = async (eventType, data) => {
            const { conversationId, created_at, messageId, message: socketMessage } = data || {};
            if (!conversationId) return;

            // Event de-duplication by messageId
            if (messageId) {
                const lastSeen = messagingStore.getLastSeenMessageId(conversationId);
                if (Number(messageId) <= Number(lastSeen)) return;
                messagingStore.setLastSeenMessageId(conversationId, messageId);
            }

            const isSelected = (messagingStore.selectedConversationId === String(conversationId));
            if (isSelected && socketMessage) {
                // Fast-path: decrypt and append without GET
                try {
                    const [decrypted] = await this.decryptMessages([socketMessage]);
                    // Reconcile pending by clientId if present
                    const clientId = socketMessage?.clientId || socketMessage?.client_id || data?.clientId || data?.client_id || null;
                    let added = false;
                    if (clientId) {
                        added = messagingStore.ackPendingMessage(conversationId, String(clientId), decrypted);
                    } else {
                        added = messagingStore.addMessage(conversationId, decrypted);
                    }
                    if (added) {
                        messagingStore.updateConversation(conversationId, {
                            last_message_created_at: decrypted.created_at,
                            last_message_encrypted: decrypted.encrypted_content,
                            last_message_sender_id: decrypted.sender_id
                        });
                    }
                } catch {
                    await applyMessageEvent(conversationId, { createdAt: created_at, isSelected });
                }
            } else if (isSelected) {
                // Refresh recent window if open
                try {
                    const response = await api.messages.getMessages(conversationId, 50, 0);
                    const decryptedMessages = await this.decryptMessages(response.messages);
                    messagingStore.setMessages(conversationId, decryptedMessages);
                } catch {
                    // swallow, next manual load will reconcile
                }
            } else {
                // For messageSent (self-sent) on unselected, do not bump unread
                const incrementUnread = eventType !== 'messageSent';
                await applyMessageEvent(conversationId, { createdAt: created_at, isSelected, incrementUnread });
            }

            if (!isSelected) {
                // Mark messages as stale so the next selection refetches
                try { messagingStore.markConversationStale(conversationId); } catch {}
            }
        };

        // Listen for new messages / message sent confirmations
        socketService.on('newMessage', (d) => handleSocketMessageEnvelope('newMessage', d));
        socketService.on('messageSent', (d) => handleSocketMessageEnvelope('messageSent', d));

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

            if (import.meta?.env?.DEV) console.log('Messaging service initialized');
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
            const payload = getTokenData?.();
            if (!payload) return null;
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

            if (offset === 0 && !before) {
                // Replace if getting latest messages
                messagingStore.setMessages(conversationId, decryptedMessages);
            } else {
                // Append older messages
                for (const message of decryptedMessages) {
                    messagingStore.addMessage(conversationId, message);
                }
            }
            // Update pagination meta
            const hasMore = (decryptedMessages.length === limit);
            const oldestTime = decryptedMessages.length > 0 ? decryptedMessages[0]?.created_at || null : null;
            messagingStore.updateMessagesMeta(conversationId, {
                lastFetchedTs: Date.now(),
                hasMore,
                oldestTime
            });
            return decryptedMessages;
        } catch (error) {
            console.error('Error getting messages:', error);
            throw error;
        }
    }

    /**
     * Load older messages for a conversation using pagination metadata
     */
    async loadOlder(conversationId, limit = 50) {
        const meta = (messagingStore.messagesMeta || {})[String(conversationId)] || {};
        const before = meta.oldestTime || null;
        if (!before) return [];
        return await this.getMessages(conversationId, limit, 0, before);
    }

    /**
     * Send an encrypted message
     */
    async sendMessage(conversationId, receiverId, message, messageType = 'text') {
        // Small helper to attempt encryption, auto-bootstrap on sender, and optionally request peer bootstrap
        const tryEncryptWithAutoBootstrap = async () => {
            try {
                return await signalAdapter.encrypt(conversationId, receiverId, message);
            } catch (err) {
                // If missing bundle on peer, request remote bootstrap and retry a couple times
                const isApi = err && (err.name === 'ApiError' || err.status !== undefined);
                const msg = String(err?.message || '');
                const status = Number(err?.status || 0);
                if (isApi && (status === 404 || msg.includes('No key bundle found'))) {
                    try {
                        // Ensure our own identity/prekeys are published now (sender-side)
                        const { bootstrapSignalIfNeeded } = await import('./signalBootstrap.js');
                        await bootstrapSignalIfNeeded();
                    } catch {}
                    // Ask the recipient to bootstrap via Socket.IO
                    try { socketService.emit('e2ee-bootstrap-request', { targetUserId: receiverId }); } catch {}
                    // Retry a few times with short delays to allow peer to publish
                    for (let i = 0; i < 3; i++) {
                        await new Promise(r => setTimeout(r, 800 + i * 400));
                        try {
                            const env = await signalAdapter.encrypt(conversationId, receiverId, message);
                            return env;
                        } catch (retryErr) {
                            const rmsg = String(retryErr?.message || '');
                            const rstatus = Number(retryErr?.status || 0);
                            if (!(retryErr && (retryErr.name === 'ApiError' || retryErr.status !== undefined) && (rstatus === 404 || rmsg.includes('No key bundle found')))) {
                                throw retryErr;
                            }
                        }
                    }
                }
                throw err;
            }
        };
        try {
            // Use Signal adapter for encryption with auto-recovery behavior
            const signalEnvelope = await tryEncryptWithAutoBootstrap();
            // Generate client-side ID for optimistic reconciliation
            const clientId = this._generateClientId();

            const response = await api.messages.sendMessage(conversationId, {
                encryptedContent: signalEnvelope.envelope,
                receiverId: receiverId,
                // Compute contentHash on plaintext for DB constraint compatibility
                contentHash: await cryptoService.generateHash(message),
                receiverSessionKey: null,
                senderSessionKey: null,
                messageType: messageType,
                clientId
            });

            // Optimistic UI: insert the just-sent message immediately.
            // Store includes de-duplicator by message ID; socket refresh will reconcile.
            try {
                const userData = this.getUserData();
                const optimistic = {
                    id: response?.message?.id ? response.message.id : `c:${clientId}`,
                    conversation_id: conversationId,
                    sender_id: userData?.userId,
                    receiver_id: receiverId,
                    encrypted_content: signalEnvelope.envelope,
                    sender_session_key: null,
                    receiver_session_key: null,
                    created_at: new Date().toISOString(),
                    read_at: null,
                    decryptedContent: message,
                    isDecrypted: true,
                    status: response?.message?.id ? 'sent' : 'pending',
                    clientId
                };
                messagingStore.addMessage(conversationId, optimistic);
            } catch (optErr) {
                console.warn('Optimistic insert skipped:', optErr?.message || optErr);
            }

            return response.message;
        } catch (error) {
            console.error('Error sending message:', error);
            // Provide a clearer error for UX when recipient is not yet provisioned
            const msg = String(error?.message || '');
            const status = Number(error?.status || 0);
            if ((error && (error.name === 'ApiError' || error.status !== undefined)) && (status === 404 || msg.includes('No key bundle found'))) {
                throw new Error('Recipient has not completed secure setup yet. We requested it automatically; please try again in a moment.');
            }
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
                    // Integrity: rely on AEAD (AES-GCM) during decrypt; no extra hash verification

                    decryptedMessages.push({
                        ...message,
                        decryptedContent: decryptedContent,
                        isDecrypted: true
                    });
                } else {
                    // Treat as Signal envelope when no legacy session keys are present
                    try {
                        const peerId = (Number(message.sender_id) === myId) ? Number(message.receiver_id) : Number(message.sender_id);
                        const conv = message.conversation_id || message.conversationId || (message.conversation && (message.conversation.id || message.conversation.conversation_id)) || null;
                        const plaintext = await signalAdapter.decrypt(conv, message.encrypted_content, peerId);
                        decryptedMessages.push({
                            ...message,
                            decryptedContent: plaintext,
                            isDecrypted: true
                        });
                    } catch (e) {
                        decryptedMessages.push({
                            ...message,
                            decryptedContent: '[Encrypted message - decryption failed]',
                            isDecrypted: false
                        });
                    }
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
        // Emit directly; socket service will queue when offline and flush on connect
        socketService.emit(event, { conversationId, userId: userData.userId });
    }

    /**
     * Join conversation room for typing indicators
    */
    joinConversation(conversationId) {
        // Emit directly; socket service will queue when offline and flush on connect
        socketService.emit('join-conversation', conversationId);
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
