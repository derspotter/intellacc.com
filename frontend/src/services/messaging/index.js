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
  DEFAULT_MLS_CIPHERSUITE,
  uint8ToBase64,
  getCachedCredentialInfo
} from '../mls/coreCryptoClient.js';
import { ensureConversationLifecycle, ensureConversationBootstrap } from '../mls/groupManager.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const pushMessagingDiagnostic = (entry = {}) => {
  try {
    messagingStore.pushDiagnosticEvent({
      category: 'messaging',
      ...entry
    });
  } catch (err) {
    if (import.meta?.env?.DEV) console.warn('Unable to record MLS diagnostic event', err);
  }
};

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

  async _syncMlsCredentialDiagnostics() {
    try {
      const info = getCachedCredentialInfo();
      if (info) {
        messagingStore.setMlsCredential({
          issuedAt: info.issuedAt ?? null,
          expiresAt: info.expiresAt ?? null,
          signer: info.signer ?? null,
          requestHash: info.requestHash ?? null,
          requestId: info.requestId ?? null,
          updatedAt: Date.now()
        });
      } else {
        messagingStore.setMlsCredential(null);
      }
    } catch (err) {
      if (import.meta?.env?.DEV) console.warn('Failed to sync MLS credential diagnostics', err);
      pushMessagingDiagnostic({
        level: 'warn',
        message: 'Failed to sync MLS credential diagnostics',
        error: err?.message || String(err)
      });
    }
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
    try {
      await ensureMlsBootstrap();
    } catch (err) {
      pushMessagingDiagnostic({
        level: 'error',
        message: 'MLS bootstrap failed during messaging initialization',
        error: err?.message || String(err)
      });
      throw err;
    }
    await this._syncMlsCredentialDiagnostics();
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
    if (existing) {
      try {
        const currentUserId = messagingStore.currentUserId ?? this.getUserData()?.userId ?? null;
        const participantIds = [existing.participant_1, existing.participant_2]
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0 && id !== Number(currentUserId));
        if (participantIds.length > 0) {
          await ensureConversationLifecycle(conversationId, participantIds);
        } else {
          await ensureConversationBootstrap(conversationId);
        }
      } catch (err) {
        if (import.meta?.env?.DEV) console.warn('Failed to bootstrap existing MLS conversation', err);
        pushMessagingDiagnostic({
          conversationId,
          level: 'warn',
          message: 'Failed to bootstrap existing MLS conversation',
          error: err?.message || String(err)
        });
      }
      return existing;
    }
    try {
      const resp = await api.messages.getConversation(conversationId);
      const conv = resp?.conversation;
      if (!conv) return null;
      messagingStore.upsertConversation(conv);
      try {
        await api.mls.upsertConversation({ conversationId, ciphersuite: DEFAULT_MLS_CIPHERSUITE });
      } catch {}
      try {
        const currentUserId = messagingStore.currentUserId ?? this.getUserData()?.userId ?? null;
        const participantIds = [conv.participant_1, conv.participant_2]
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0 && id !== Number(currentUserId));
        if (participantIds.length > 0) {
          await ensureConversationLifecycle(conversationId, participantIds);
        } else {
          await ensureConversationBootstrap(conversationId);
        }
      } catch (err) {
        if (import.meta?.env?.DEV) console.warn('Failed to bootstrap MLS conversation lifecycle', err);
        pushMessagingDiagnostic({
          conversationId,
          level: 'warn',
          message: 'Failed to bootstrap MLS conversation lifecycle',
          error: err?.message || String(err)
        });
      }
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

  async migrateConversation(conversationId, { ciphersuite = DEFAULT_MLS_CIPHERSUITE } = {}) {
    if (!conversationId) return null;
    const numericId = Number(conversationId);
    if (!Number.isFinite(numericId)) throw new Error('Conversation id must be numeric');
    await api.mls.migrateConversation({ conversationId: numericId, ciphersuite });
    messagingStore.updateConversation(numericId, {
      encryptionMode: 'mls',
      mlsMigrationEligible: false
    });
    messagingStore.recordMlsDiagnostics(numericId, {
      lastMigrationAt: Date.now()
    });
    pushMessagingDiagnostic({
      conversationId: numericId,
      level: 'info',
      message: 'Conversation migrated to MLS',
      data: { ciphersuite }
    });
    try {
      await ensureConversationLifecycle(numericId, []);
    } catch (err) {
      pushMessagingDiagnostic({
        conversationId: numericId,
        level: 'warn',
        message: 'Failed to complete MLS lifecycle after migration',
        error: err?.message || String(err)
      });
    }
    return true;
  }

  async createConversation(otherUserId) {
    const response = await api.messages.createConversation(otherUserId);
    messagingStore.addConversation(response.conversation);
    try {
      await api.mls.upsertConversation({ conversationId: response.conversation.id, ciphersuite: DEFAULT_MLS_CIPHERSUITE });
    } catch {}
    try {
      await ensureConversationLifecycle(response.conversation.id, [otherUserId]);
    } catch (err) {
      if (import.meta?.env?.DEV) console.warn('Failed to initialize MLS conversation', err);
    }
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
        const senderClientBytes = result?.senderClientId?.copyBytes?.() || null;
        const senderClientIdB64 = senderClientBytes?.length ? uint8ToBase64(senderClientBytes) : (message.senderClientId ?? message.sender_client_id ?? null);
        const commitDelaySeconds = typeof result?.commitDelay === 'number' ? result.commitDelay : null;
        const hasEpochChanged = Boolean(result?.hasEpochChanged);
        decrypted.push({
          id: message.id,
          conversation_id: conversationId,
          sender_id: message.senderUserId ?? message.user_id ?? message.sender_id,
          encrypted_content: ciphertextB64,
          created_at: message.createdAt ?? message.created_at,
          decryptedContent: plaintext,
          isDecrypted: true,
          epoch: message.epoch ?? null,
          sender_client_id: senderClientIdB64,
          status: 'sent'
        });
        messagingStore.recordMlsDiagnostics(conversationId, {
          lastDecryptedAt: Date.now(),
          lastSenderClientId: senderClientIdB64 ?? null,
          lastCommitDelaySeconds: commitDelaySeconds,
          lastEpochChanged: hasEpochChanged
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
        messagingStore.recordMlsDiagnostics(conversationId, {
          lastDecryptionError: err?.message || String(err)
        });
        pushMessagingDiagnostic({
          conversationId,
          level: 'error',
          message: 'Failed to decrypt MLS message',
          error: err?.message || String(err),
          data: { messageId: message.id }
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
    try {
      await ensureMlsBootstrap();
    } catch (err) {
      pushMessagingDiagnostic({
        conversationId,
        level: 'error',
        message: 'MLS bootstrap failed before sending message',
        error: err?.message || String(err)
      });
      throw err;
    }
    await this._syncMlsCredentialDiagnostics();
    const coreCrypto = await getCoreCrypto();
    if (!coreCrypto) {
      pushMessagingDiagnostic({
        conversationId,
        level: 'error',
        message: 'MLS core crypto not ready'
      });
      throw new Error('MLS core crypto not ready');
    }
    this._clientIdBase64 = this._clientIdBase64 || getClientIdBase64();
    const clientId = this._generateClientId();

    const plaintext = textEncoder.encode(String(message ?? ''));
    const convId = createConversationId(conversationId);
    const { ciphertext, epoch: epochNumber } = await coreCrypto.transaction(async (ctx) => {
      const encrypted = await ctx.encryptMessage(convId, plaintext);
      let epochValue = null;
      try {
        epochValue = await ctx.conversationEpoch(convId);
      } catch {}
      return { ciphertext: encrypted, epoch: epochValue };
    });
    const ciphertextB64 = bytesToBase64(ciphertext);

    try {
      await api.mls.sendMessage({
        conversationId,
        senderClientId: this._clientIdBase64,
        epoch: epochNumber ?? null,
        ciphertext: ciphertextB64
      });
    } catch (err) {
      pushMessagingDiagnostic({
        conversationId,
        level: 'error',
        message: 'Failed to send MLS message',
        error: err?.message || String(err),
        data: { clientId, epoch: epochNumber ?? null }
      });
      throw err;
    }

    try {
      const userData = this.getUserData();
      const nowIso = new Date().toISOString();
      const optimistic = {
        id: `c:${clientId}`,
        conversation_id: conversationId,
        sender_id: userData?.userId,
        encrypted_content: ciphertextB64,
        created_at: nowIso,
        decryptedContent: String(message ?? ''),
        isDecrypted: true,
        status: 'pending',
        clientId,
        sender_client_id: this._clientIdBase64,
        epoch: epochNumber ?? null
      };
      messagingStore.addMessage(conversationId, optimistic);
      messagingStore.updateConversation(conversationId, {
        last_message_created_at: optimistic.created_at,
        last_message_encrypted: ciphertextB64,
        last_message_sender_id: userData?.userId,
        last_message_type: messageType,
        last_message_sender_client_id: this._clientIdBase64 ?? null,
        last_message_epoch: epochNumber ?? null
      });
      messagingStore.recordMlsDiagnostics(conversationId, {
        lastSentAt: nowIso,
        lastSentClientId: this._clientIdBase64 ?? null,
        lastSentEpoch: epochNumber ?? null
      });
    } catch (optErr) {
      console.warn('Optimistic MLS insert skipped:', optErr?.message || optErr);
      pushMessagingDiagnostic({
        conversationId,
        level: 'warn',
        message: 'Optimistic MLS insert skipped',
        error: optErr?.message || String(optErr),
        data: { clientId }
      });
    }
  }

  async markMessagesAsRead(messageIds) {
    messagingStore.markMessagesAsRead(messageIds);
    return { ok: true };
  }

  async getUnreadCount() {
    return 0;
  }

  async deleteMessage(messageId) {
    messagingStore.removeMessage(messageId);
    return { ok: true };
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
