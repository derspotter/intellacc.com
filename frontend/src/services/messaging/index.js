// frontend/src/services/messaging/index.js
// MLS-native messaging service

import api from '../api.js';
import messagingStore from '../../stores/messagingStore.js';
import socketService from '../socket.js';
import { getTokenData } from '../auth.js';
import {
  ensureMlsBootstrap,
  getCoreCrypto,
  createConversationId,
  getClientIdBase64,
  DEFAULT_MLS_CIPHERSUITE
} from '../mls/coreCryptoClient.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const base64ToBytes = (value) => {
  if (!value) return new Uint8Array();
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const bytesToBase64 = (bytes) => {
  if (!bytes) return '';
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

class MlsMessagingService {
  constructor() {
    this._connectHandlerAdded = false;
    this._clientIdBase64 = null;
    this.setupSocketHandlers();
  }

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

  setupSocketHandlers() {
    const applyMessageEvent = async (conversationId, { createdAt = null, isSelected = false, incrementUnread = true } = {}) => {
      try {
        if (isSelected) {
          await this.getMessages(conversationId, 50, 0, null);
        } else {
          if (incrementUnread) {
            messagingStore.incrementUnread(conversationId, 1);
          }
          const ts = createdAt || new Date().toISOString();
          messagingStore.updateConversation(conversationId, { last_message_created_at: ts });
        }
      } catch {}
    };

    const handleSocketMessageEnvelope = async (eventType, data) => {
      const { conversationId, created_at, messageId } = data || {};
      if (!conversationId) return;

      if (messageId) {
        const lastSeen = messagingStore.getLastSeenMessageId(conversationId);
        if (Number(messageId) <= Number(lastSeen)) return;
        messagingStore.setLastSeenMessageId(conversationId, messageId);
      }

      const isSelected = (messagingStore.selectedConversationId === String(conversationId));
      if (isSelected) {
        try {
          await this.getMessages(conversationId, 50, 0, null);
        } catch {}
      } else {
        const incrementUnread = eventType !== 'messageSent';
        await applyMessageEvent(conversationId, { createdAt: created_at, isSelected, incrementUnread });
      }

      if (!isSelected) {
        try { messagingStore.markConversationStale(conversationId); } catch {}
      }
    };

    socketService.on('newMessage', (d) => handleSocketMessageEnvelope('newMessage', d));
    socketService.on('messageSent', (d) => handleSocketMessageEnvelope('messageSent', d));

    socketService.on('messagesRead', (data) => this.handleMessagesRead(data));
    socketService.on('messageDeleted', (data) => this.handleMessageDeleted(data));
    socketService.on('user-typing', (data) => this.handleTypingIndicator(data));
    socketService.on('mls:message', () => {
      const conversationId = messagingStore.selectedConversationId;
      if (conversationId) {
        this.getMessages(conversationId, 50, 0, null).catch(() => {});
      }
    });
    socketService.on('mls:commit', (payload = {}) => {
      const conversationId = payload.conversationId ?? payload.conversation_id;
      if (conversationId) {
        try { messagingStore.markConversationStale(conversationId); } catch {}
      }
    });
  }

  async initialize() {
    await ensureMlsBootstrap();
    this._clientIdBase64 = getClientIdBase64();
    if (import.meta?.env?.DEV) console.log('MLS messaging initialized');
  }

  getUserData() {
    try {
      const payload = getTokenData?.();
      if (!payload) return null;
      return { userId: payload.userId, username: payload.username };
    } catch {
      return null;
    }
  }

  async ensureConversation(conversationId) {
    const idStr = String(conversationId);
    const existing = (messagingStore.conversations || []).find(c => String(c.id) === idStr);
    if (existing) return existing;
    try {
      const resp = await api.messages.getConversation(conversationId);
      const conv = resp?.conversation;
      if (!conv) return null;
      messagingStore.upsertConversation(conv);
      try {
        await api.mls.upsertConversation({ conversationId, ciphersuite: DEFAULT_MLS_CIPHERSUITE });
      } catch {}
      return messagingStore.conversationsById?.[idStr] || conv;
    } catch {
      return null;
    }
  }

  async getConversations(limit = 20, offset = 0) {
    const response = await api.messages.getConversations(limit, offset);
    messagingStore.upsertConversations(response.conversations || []);
    return messagingStore.conversations;
  }

  async createConversation(otherUserId) {
    const response = await api.messages.createConversation(otherUserId);
    messagingStore.addConversation(response.conversation);
    try {
      await api.mls.upsertConversation({ conversationId: response.conversation.id, ciphersuite: DEFAULT_MLS_CIPHERSUITE });
    } catch {}
    return response.conversation;
  }

  async decryptMessages(conversationId, messages) {
    const coreCrypto = await getCoreCrypto();
    if (!coreCrypto) return [];
    const convId = createConversationId(conversationId);
    const decrypted = [];
    for (const message of messages) {
      const ciphertextB64 = message.ciphertext || message.encrypted_content;
      if (!ciphertextB64) continue;
      try {
        const ciphertext = base64ToBytes(ciphertextB64);
        const result = await coreCrypto.transaction((ctx) => ctx.decryptMessage(convId, ciphertext));
        const plaintext = result?.message ? textDecoder.decode(result.message) : '';
        decrypted.push({
          id: message.id,
          conversation_id: conversationId,
          sender_id: message.senderUserId ?? message.user_id ?? message.sender_id,
          encrypted_content: ciphertextB64,
          created_at: message.createdAt ?? message.created_at,
          decryptedContent: plaintext,
          isDecrypted: true,
          epoch: message.epoch ?? null,
          sender_client_id: message.senderClientId ?? null,
          status: 'sent'
        });
      } catch (err) {
        console.warn('Failed to decrypt MLS message', err);
        decrypted.push({
          id: message.id,
          conversation_id: conversationId,
          sender_id: message.senderUserId ?? message.user_id ?? message.sender_id,
          encrypted_content: ciphertextB64,
          created_at: message.createdAt ?? message.created_at,
          decryptedContent: null,
          isDecrypted: false,
          epoch: message.epoch ?? null,
          sender_client_id: message.senderClientId ?? null,
          status: 'sent'
        });
      }
    }
    decrypted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return decrypted;
  }

  async getMessages(conversationId, limit = 50, offset = 0, before = null) {
    const params = { limit };
    if (before) params.before = before;
    const response = await api.mls.getMessages(conversationId, params);
    const decryptedMessages = await this.decryptMessages(conversationId, response.items || []);
    if (offset === 0 && !before) {
      messagingStore.setMessages(conversationId, decryptedMessages);
    } else {
      decryptedMessages.forEach((msg) => messagingStore.addMessage(conversationId, msg));
    }
    const hasMore = decryptedMessages.length === limit;
    const oldestTime = decryptedMessages.length > 0 ? decryptedMessages[0]?.created_at || null : null;
    messagingStore.updateMessagesMeta(conversationId, {
      lastFetchedTs: Date.now(),
      hasMore,
      oldestTime
    });
    return decryptedMessages;
  }

  async loadOlder(conversationId, limit = 50) {
    const meta = (messagingStore.messagesMeta || {})[String(conversationId)] || {};
    const before = meta.oldestTime || null;
    if (!before) return [];
    return await this.getMessages(conversationId, limit, 0, before);
  }

  async sendMessage(conversationId, receiverId, message, messageType = 'text') {
    await ensureMlsBootstrap();
    const coreCrypto = await getCoreCrypto();
    if (!coreCrypto) throw new Error('MLS core crypto not ready');
    this._clientIdBase64 = this._clientIdBase64 || getClientIdBase64();
    const clientId = this._generateClientId();

    const plaintext = textEncoder.encode(String(message ?? ''));
    const convId = createConversationId(conversationId);
    const ciphertext = await coreCrypto.transaction((ctx) => ctx.encryptMessage(convId, plaintext));
    const ciphertextB64 = bytesToBase64(ciphertext);

    await api.mls.sendMessage({
      conversationId,
      senderClientId: this._clientIdBase64,
      epoch: null,
      ciphertext: ciphertextB64
    });

    try {
      const userData = this.getUserData();
      const optimistic = {
        id: `c:${clientId}`,
        conversation_id: conversationId,
        sender_id: userData?.userId,
        encrypted_content: ciphertextB64,
        created_at: new Date().toISOString(),
        decryptedContent: String(message ?? ''),
        isDecrypted: true,
        status: 'pending',
        clientId
      };
      messagingStore.addMessage(conversationId, optimistic);
      messagingStore.updateConversation(conversationId, {
        last_message_created_at: optimistic.created_at,
        last_message_encrypted: ciphertextB64,
        last_message_sender_id: userData?.userId,
        last_message_type: messageType
      });
    } catch (optErr) {
      console.warn('Optimistic MLS insert skipped:', optErr?.message || optErr);
    }
  }

  async markMessagesAsRead(messageIds) {
    const response = await api.messages.markAsRead(messageIds);
    messagingStore.markMessagesAsRead(messageIds);
    return response;
  }

  async getUnreadCount() {
    const response = await api.messages.getUnreadCount();
    return response.count;
  }

  async deleteMessage(messageId) {
    const response = await api.messages.deleteMessage(messageId);
    messagingStore.removeMessage(messageId);
    return response;
  }

  sendTypingIndicator(conversationId, isTyping) {
    const userData = this.getUserData();
    if (!userData) return;
    const event = isTyping ? 'typing-start' : 'typing-stop';
    socketService.emit(event, { conversationId, userId: userData.userId });
  }

  joinConversation(conversationId) {
    socketService.emit('join-conversation', conversationId);
  }

  leaveConversation(conversationId) {
    if (socketService.state.connected.val) {
      socketService.emit('leave-conversation', conversationId);
    }
  }

  clearCache() {
    messagingStore.clearCache();
  }

  handleMessagesRead(data) {
    const { messageIds } = data || {};
    if (Array.isArray(messageIds)) {
      messagingStore.markMessagesAsRead(messageIds);
    }
  }

  handleMessageDeleted(data) {
    const { messageId } = data || {};
    if (messageId != null) messagingStore.removeMessage(messageId);
  }

  handleTypingIndicator(data = {}) {
    const { userId, isTyping } = data;
    if (isTyping) {
      messagingStore.addTypingUser(userId);
    } else {
      messagingStore.removeTypingUser(userId);
    }
  }
}

const messagingService = new MlsMessagingService();
messagingService.ciphersuite = DEFAULT_MLS_CIPHERSUITE;

export default messagingService;
