// frontend/src/services/messaging/index.js
// Chooses between legacy Signal-based messaging and the MLS implementation

import legacyMessagingService from '../messaging-legacy/messaging.js';
import socketService from '../socket.js';
import messagingStore from '../../stores/messagingStore.js';
import api from '../api.js';
import {
  isMlsEnabled,
  ensureMlsBootstrap,
  getCoreCrypto,
  getClientIdBase64,
  createConversationId,
  uint8ToBase64,
  DEFAULT_MLS_CIPHERSUITE
} from '../mls/coreCryptoClient.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64ToBytes(value) {
  if (!value) return new Uint8Array();
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  return uint8ToBase64(bytes);
}

function applyMlsOverrides(service) {
  if (service.__mlsPatched) return service;

  let clientIdBase64 = null;
  let handlersRegistered = false;

  const ensureClientId = () => {
    if (!clientIdBase64) clientIdBase64 = getClientIdBase64();
    return clientIdBase64;
  };

  const decryptMessages = async (conversationId, messages) => {
    const coreCrypto = await getCoreCrypto();
    if (!coreCrypto) return [];
    const convId = createConversationId(conversationId);
    const results = [];
    for (const item of messages) {
      try {
        const ciphertextB64 = item.ciphertext || item.encrypted_content;
        if (!ciphertextB64) continue;
        const ciphertext = base64ToBytes(ciphertextB64);
        const decrypted = await coreCrypto.transaction(async (ctx) => ctx.decryptMessage(convId, ciphertext));
        const plaintext = decrypted?.message ? textDecoder.decode(decrypted.message) : '';
        results.push({
          id: item.id,
          conversation_id: conversationId,
          sender_id: item.senderUserId ?? item.user_id ?? item.sender_id,
          encrypted_content: ciphertextB64,
          created_at: item.createdAt ?? item.created_at,
          decryptedContent: plaintext,
          isDecrypted: true,
          epoch: item.epoch ?? null,
          sender_client_id: item.senderClientId ?? null,
          status: 'sent'
        });
      } catch (err) {
        console.warn('MLS decrypt failed; leaving ciphertext', err);
        results.push({
          id: item.id,
          conversation_id: conversationId,
          sender_id: item.senderUserId ?? item.user_id ?? item.sender_id,
          encrypted_content: item.ciphertext || item.encrypted_content,
          created_at: item.createdAt ?? item.created_at,
          decryptedContent: null,
          isDecrypted: false,
          epoch: item.epoch ?? null,
          sender_client_id: item.senderClientId ?? null,
          status: 'sent'
        });
      }
    }
    results.sort((a, b) => (new Date(a.created_at).getTime()) - (new Date(b.created_at).getTime()));
    return results;
  };

  const registerSocketHandlers = () => {
    if (handlersRegistered) return;
    handlersRegistered = true;

    const handleMlsMessage = async (payload = {}) => {
      const conversationId = payload.conversationId ?? payload.conversation_id;
      if (conversationId == null) return;
      const isSelected = String(messagingStore.selectedConversationId) === String(conversationId);
      if (isSelected) {
        try {
          await service.getMessages(conversationId, 50, 0, null);
        } catch (err) {
          console.warn('Failed to refresh MLS messages from socket event', err);
        }
      } else {
        try { messagingStore.incrementUnread(conversationId, 1); } catch {}
        try { messagingStore.markConversationStale(conversationId); } catch {}
      }
    };

    const handleMlsCommit = (payload = {}) => {
      const conversationId = payload.conversationId ?? payload.conversation_id;
      if (conversationId == null) return;
      try { messagingStore.markConversationStale(conversationId); } catch {}
    };

    socketService.on('mls:message', handleMlsMessage);
    socketService.on('mls:commit', handleMlsCommit);
  };

  service.initialize = async function initializeMls() {
    await ensureMlsBootstrap();
    ensureClientId();
    registerSocketHandlers();
    if (import.meta?.env?.DEV) console.log('MLS messaging initialized');
  };

  service.getMessages = async function mlsGetMessages(conversationId, limit = 50, offset = 0, before = null) {
    const params = { limit };
    if (before) params.before = before;
    const response = await api.mls.getMessages(conversationId, params);
    const decrypted = await decryptMessages(conversationId, response.items || []);
    if (offset === 0 && !before) {
      messagingStore.setMessages(conversationId, decrypted);
    } else {
      decrypted.forEach((msg) => messagingStore.addMessage(conversationId, msg));
    }
    const hasMore = decrypted.length === limit;
    const oldest = decrypted.length ? decrypted[0]?.created_at ?? null : null;
    messagingStore.updateMessagesMeta(conversationId, {
      lastFetchedTs: Date.now(),
      hasMore,
      oldestTime: oldest
    });
    return decrypted;
  };

  service.loadOlder = async function mlsLoadOlder(conversationId, limit = 50) {
    const meta = (messagingStore.messagesMeta || {})[String(conversationId)] || {};
    const before = meta.oldestTime || null;
    if (!before) return [];
    return await service.getMessages(conversationId, limit, 0, before);
  };

  service.sendMessage = async function mlsSendMessage(conversationId, receiverId, message, messageType = 'text') {
    await ensureMlsBootstrap();
    const coreCrypto = await getCoreCrypto();
    if (!coreCrypto) {
      throw new Error('MLS core crypto not initialized');
    }
    ensureClientId();
    const clientId = service._generateClientId();
    const plaintext = textEncoder.encode(String(message ?? ''));
    const convId = createConversationId(conversationId);
    const ciphertext = await coreCrypto.transaction(async (ctx) => ctx.encryptMessage(convId, plaintext));
    const ciphertextB64 = bytesToBase64(ciphertext);

    await api.mls.sendMessage({
      conversationId,
      senderClientId: clientIdBase64,
      epoch: null,
      ciphertext: ciphertextB64
    });

    try {
      const userData = service.getUserData();
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
  };

  service.getUnreadCount = async function mlsGetUnreadCount() {
    const response = await api.messages.getUnreadCount();
    return response.count;
  };

  service.markMessagesAsRead = async function mlsMarkRead(messageIds) {
    const response = await api.messages.markAsRead(messageIds);
    messagingStore.markMessagesAsRead(messageIds);
    return response;
  };

  service.deleteMessage = async function mlsDeleteMessage(messageId) {
    const response = await api.messages.deleteMessage(messageId);
    messagingStore.removeMessage(messageId);
    return response;
  };

  service.mlsCiphersuite = DEFAULT_MLS_CIPHERSUITE;
  service.__mlsPatched = true;
  return service;
}

const messagingService = isMlsEnabled() ? applyMlsOverrides(legacyMessagingService) : legacyMessagingService;

export default messagingService;
