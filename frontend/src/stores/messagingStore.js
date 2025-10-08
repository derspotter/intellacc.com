// frontend/src/stores/messagingStore.js
// Central reactive store for messaging state management

import * as vanX from 'vanjs-ext';
import { normalizeConversation } from '../utils/messagingUtils.js';
import { getTokenData } from '../services/auth.js';

const MAX_DIAGNOSTIC_EVENTS = 100;

// Helper: sort ids by their conversation's lastTs (desc)
const sortIdsByTs = (byId, ids) => ids.sort((a, b) => ((byId[b]?.lastTs || 0) - (byId[a]?.lastTs || 0)));

/**
 * Central messaging store using VanX reactive patterns
 * Manages all messaging state with automatic reactivity
 */
const messagingStore = vanX.reactive({
  // Core state
  conversations: [],
  conversationsById: {},
  conversationIds: [],
  currentUserId: null,
  messagesMeta: {},
  messagesByConversation: {}, // Use plain object instead of Map for VanX compatibility
  selectedConversationId: null,
  conversationsLoading: false,
  messagesLoading: false,
  error: '',
  eventsMeta: {},
  mlsMeta: {},
  mlsCredential: null,
  mlsDiagnosticEvents: [],
  
  // Typing indicators - use array instead of Set for VanX compatibility
  typingUsers: [],
  
  // New conversation form
  showNewConversation: false,
  newConversationUser: '',
  newMessage: '',
  
  // Search
  searchQuery: '',
  
  // Calculated fields will be added after store creation
  
  // Store methods for managing state
  setCurrentUserId(userId) {
    messagingStore.currentUserId = userId != null ? Number(userId) : null;
  },
  upsertConversations(rawList) {
    const currentUserId = (messagingStore.currentUserId != null)
      ? messagingStore.currentUserId
      : (() => { try { return getTokenData()?.userId ?? null; } catch { return null; } })();
    const byId = { ...(messagingStore.conversationsById || {}) };
    for (const raw of rawList || []) {
      const norm = normalizeConversation(raw, currentUserId);
      if (!norm) continue;
      const prev = byId[norm.id];
      byId[norm.id] = prev ? { ...prev, ...norm } : norm;
    }
    // Rebuild ids sorted by time desc
    const ids = Object.values(byId).map(c => String(c.id));
    sortIdsByTs(byId, ids);
    messagingStore.conversationsById = byId;
    messagingStore.conversationIds = ids;
    messagingStore.conversations = ids.map(id => byId[id]);
  },

  upsertConversation(raw) {
    const currentUserId = (messagingStore.currentUserId != null)
      ? messagingStore.currentUserId
      : (() => { try { return getTokenData()?.userId ?? null; } catch { return null; } })();
    const norm = normalizeConversation(raw, currentUserId);
    if (!norm) return;
    const byId = { ...(messagingStore.conversationsById || {}) };
    byId[norm.id] = byId[norm.id] ? { ...byId[norm.id], ...norm } : norm;
    // Rebuild ids keeping existing order, then ensure id exists and sort by time desc
    const set = new Set(messagingStore.conversationIds || []);
    set.add(norm.id);
    let ids = Array.from(set);
    sortIdsByTs(byId, ids);
    messagingStore.conversationsById = byId;
    messagingStore.conversationIds = ids;
    messagingStore.conversations = ids.map(id => byId[id]);
  },
  setConversations(conversations) {
    // Replace current conversations with the provided list
    messagingStore.conversationsById = {};
    messagingStore.conversationIds = [];
    messagingStore.conversations = [];
    messagingStore.upsertConversations(conversations || []);
  },
  
  addConversation(conversation) {
    const currentUserId = (messagingStore.currentUserId != null)
      ? messagingStore.currentUserId
      : (() => { try { return getTokenData()?.userId ?? null; } catch { return null; } })();
    const id = String(conversation?.id ?? conversation?.conversation_id ?? '');
    if (!id) return;
    // Delegate to normalized single upsert
    messagingStore.upsertConversation({ ...conversation, id });
  },
  
  updateConversation(conversationId, updates) {
    const idStr = String(conversationId);
    messagingStore.conversations = messagingStore.conversations.map(conv => {
      if (conv.id !== idStr) return conv;
      const next = { ...conv, ...updates };
      // Keep derived lastTime/lastTs in sync when backend time fields change
      const lt = updates?.last_message_created_at || updates?.last_message_at || updates?.updated_at || updates?.created_at;
      if (lt) {
        next.lastTime = lt;
        next.lastTs = Date.parse(lt) || next.lastTs || 0;
      }
      // If displayName not set, preserve existing
      if (!next.displayName && conv.displayName) next.displayName = conv.displayName;
      return next;
    });
    // also update byId entry
    const current = messagingStore.conversations.find(c => c.id === idStr);
    if (current) {
      messagingStore.conversationsById = { ...messagingStore.conversationsById, [idStr]: current };
    }
  },

  // Single-mode E2EE: no per-conversation encryption mode toggles

  incrementUnread(conversationId, delta = 1) {
    const idStr = String(conversationId);
    messagingStore.conversations = messagingStore.conversations.map(conv => {
      if (conv.id === idStr) {
        const myId = (messagingStore.currentUserId != null)
          ? Number(messagingStore.currentUserId)
          : (() => { try { return Number(getTokenData()?.userId); } catch { return NaN; } })();
        const field = (conv.participant_1 === myId) ? 'unread_count_participant_1' : 'unread_count_participant_2';
        const current = conv[field] || 0;
        const myUnread = (conv.my_unread_count || 0) + delta;
        return { ...conv, [field]: current + delta, my_unread_count: myUnread };
      }
      return conv;
    });
    const current = messagingStore.conversations.find(c => c.id === idStr);
    if (current) {
      messagingStore.conversationsById = { ...messagingStore.conversationsById, [idStr]: current };
    }
  },
  
  setMessages(conversationId, messages) {
    // Create new object to trigger reactivity
    const key = String(conversationId);
    messagingStore.messagesByConversation = {
      ...messagingStore.messagesByConversation,
      [key]: [...messages]
    };
    // update meta
    // Track last fetched time
    const now = Date.now();
    const meta = { ...(messagingStore.messagesMeta || {}) };
    meta[key] = { lastFetchedTs: now };
    messagingStore.messagesMeta = meta;
  },

  updateMessagesMeta(conversationId, updates) {
    const key = String(conversationId);
    const meta = { ...(messagingStore.messagesMeta || {}) };
    const prev = meta[key] || {};
    meta[key] = { ...prev, ...updates };
    messagingStore.messagesMeta = meta;
  },
  
  addMessage(conversationId, message) {
    const key = String(conversationId);
    const existingMessages = messagingStore.messagesByConversation[key] || [];
    
    // Check for duplicates by ID
    const messageExists = existingMessages.some(m => m.id === message.id);
      if (messageExists) return false;
    
    // Add message in chronological order
    const newMessages = [...existingMessages];
    const insertIndex = newMessages.findIndex(m => new Date(m.created_at) > new Date(message.created_at));
    
    if (insertIndex === -1) {
      newMessages.push(message);
    } else {
      newMessages.splice(insertIndex, 0, message);
    }
    
    // Update object to trigger reactivity
    messagingStore.messagesByConversation = {
      ...messagingStore.messagesByConversation,
      [key]: newMessages
    };
    
    return true;
  },

  // Acknowledge a pending message by clientId and update with server data
  ackPendingMessage(conversationId, clientId, serverMessage) {
    const key = String(conversationId);
    const existing = messagingStore.messagesByConversation[key] || [];
    const findIdx = existing.findIndex(m => m.clientId === clientId || m.id === `c:${clientId}`);
    if (findIdx === -1) {
      // No pending message found; insert normally (will de-dupe by id)
      return messagingStore.addMessage(conversationId, serverMessage);
    }
    const updated = [...existing];
    const prev = updated[findIdx] || {};
    // Preserve decrypted content if present; prefer server fields
    updated[findIdx] = {
      ...prev,
      ...serverMessage,
      id: serverMessage.id,
      status: 'sent',
      clientId
    };
    messagingStore.messagesByConversation = {
      ...messagingStore.messagesByConversation,
      [key]: updated
    };
    return true;
  },
  
  updateMessage(messageId, updates) {
    // Find and update message across all conversations
    for (const [conversationId, messages] of Object.entries(messagingStore.messagesByConversation)) {
      const messageIndex = messages.findIndex(m => m.id === messageId);
      if (messageIndex !== -1) {
        const newMessages = [...messages];
        newMessages[messageIndex] = { ...newMessages[messageIndex], ...updates };
        
        messagingStore.messagesByConversation = {
          ...messagingStore.messagesByConversation,
          [conversationId]: newMessages
        };
        break;
      }
    }
  },

  // Mark a conversation's messages as stale to force refresh on next selection
  markConversationStale(conversationId) {
    const meta = { ...(messagingStore.messagesMeta || {}) };
    const key = String(conversationId);
    const prev = meta[key] || {};
    meta[key] = { ...prev, lastFetchedTs: 0 };
    messagingStore.messagesMeta = meta;
  },

  setMlsPending(conversationId, info = {}) {
    const key = String(conversationId);
    const meta = { ...(messagingStore.mlsMeta || {}) };
    const previous = meta[key] || {};
    const next = { ...previous };
    if (info && typeof info === 'object') {
      if (info.epoch != null) next.epoch = Number(info.epoch);
      if (info.historySharingEnabled != null) next.historySharing = Boolean(info.historySharingEnabled);
      if (info.ciphersuite) next.ciphersuite = info.ciphersuite;
      Object.assign(next, info);
    }
    next.receivedAt = Date.now();
    meta[key] = next;
    messagingStore.mlsMeta = meta;
  },

  recordMlsDiagnostics(conversationId, info = {}) {
    if (!conversationId && conversationId !== 0) return;
    const key = String(conversationId);
    const meta = { ...(messagingStore.mlsMeta || {}) };
    const prev = meta[key] || {};
    const next = { ...prev };
    if (info && typeof info === 'object') {
      if (info.epoch != null) next.epoch = Number(info.epoch);
      if (info.historySharingEnabled != null) next.historySharing = Boolean(info.historySharingEnabled);
      if (info.ciphersuite) next.ciphersuite = info.ciphersuite;
      Object.assign(next, info);
    }
    next.lastUpdatedAt = Date.now();
    meta[key] = next;
    messagingStore.mlsMeta = meta;
  },

  setMlsCredential(info) {
    messagingStore.mlsCredential = info ? { ...info } : null;
  },

  pushDiagnosticEvent(entry = {}) {
    const timestamp = Number.isFinite(entry.timestamp) ? Number(entry.timestamp) : Date.now();
    const conversationId = entry.conversationId != null ? String(entry.conversationId) : null;
    const level = typeof entry.level === 'string' ? entry.level.toLowerCase() : 'info';
    const category = entry.category || entry.type || 'general';
    const id = entry.id || `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;

    const record = {
      id,
      timestamp,
      level,
      category,
      conversationId,
      message: entry.message ?? '',
      data: entry.data ?? null,
      error: entry.error ?? null,
      context: entry.context ?? null
    };

    const next = [...(messagingStore.mlsDiagnosticEvents || []), record];
    messagingStore.mlsDiagnosticEvents = next.slice(-MAX_DIAGNOSTIC_EVENTS);

    if (conversationId) {
      messagingStore.recordMlsDiagnostics(conversationId, {
        lastEventId: id,
        lastEventLevel: level,
        lastEventCategory: category,
        lastEventMessage: record.message,
        lastEventAt: timestamp
      });
    }
  },

  clearDiagnosticEvents() {
    messagingStore.mlsDiagnosticEvents = [];
  },

  getLastSeenMessageId(conversationId) {
    const key = String(conversationId);
    return (messagingStore.eventsMeta?.[key]?.lastSeenMessageId) ?? 0;
  },

  setLastSeenMessageId(conversationId, messageId) {
    const key = String(conversationId);
    const meta = { ...(messagingStore.eventsMeta || {}) };
    const prev = meta[key] || {};
    meta[key] = { ...prev, lastSeenMessageId: Number(messageId) || 0, lastSeenAt: Date.now() };
    messagingStore.eventsMeta = meta;
  },
  
  removeMessage(messageId) {
    // Find and remove message across all conversations
    for (const [conversationId, messages] of Object.entries(messagingStore.messagesByConversation)) {
      const filteredMessages = messages.filter(m => m.id !== messageId);
      if (filteredMessages.length !== messages.length) {
        messagingStore.messagesByConversation = {
          ...messagingStore.messagesByConversation,
          [conversationId]: filteredMessages
        };
        break;
      }
    }
  },
  
  markMessagesAsRead(messageIds) {
    const now = new Date().toISOString();
    
    // Update read status for specified messages
    for (const [conversationId, messages] of Object.entries(messagingStore.messagesByConversation)) {
      let updated = false;
      const newMessages = messages.map(message => {
        if (messageIds.includes(message.id)) {
          updated = true;
          return { ...message, read_at: now };
        }
        return message;
      });
      
      if (updated) {
        messagingStore.messagesByConversation = {
          ...messagingStore.messagesByConversation,
          [conversationId]: newMessages
        };
      }
    }
  },
  
  selectConversation(conversationId) {
    const id = String(conversationId ?? '');
    messagingStore.selectedConversationId = id;
    // Clear typing indicators when switching conversations
    messagingStore.typingUsers = [];
  },
  
  clearSelection() {
    messagingStore.selectedConversationId = null;
    messagingStore.typingUsers = [];
  },
  
  setTypingUsers(userIds) {
    messagingStore.typingUsers = [...userIds];
  },
  
  addTypingUser(userId) {
    if (!messagingStore.typingUsers.includes(userId)) {
      messagingStore.typingUsers = [...messagingStore.typingUsers, userId];
    }
  },
  
  removeTypingUser(userId) {
    messagingStore.typingUsers = messagingStore.typingUsers.filter(id => id !== userId);
  },
  

  setConversationsLoading(loading) {
    messagingStore.conversationsLoading = loading;
  },

  setMessagesLoading(loading) {
    messagingStore.messagesLoading = loading;
  },
  
  setError(error) {
    messagingStore.error = error;
  },
  
  clearError() {
    messagingStore.error = '';
  },
  
  setShowNewConversation(show) {
    messagingStore.showNewConversation = show;
  },
  
  setNewConversationUser(user) {
    messagingStore.newConversationUser = user;
  },
  
  setNewMessage(message) {
    messagingStore.newMessage = message;
  },
  
  setSearchQuery(query) {
    try { if (import.meta?.env?.DEV) console.log('[Store.setSearchQuery] ->', query); } catch {}
    messagingStore.searchQuery = query;
  },
  
  clearCache() {
    messagingStore.conversations = [];
    messagingStore.conversationsById = {};
    messagingStore.conversationIds = [];
    messagingStore.messagesByConversation = {};
    messagingStore.messagesMeta = {};
    messagingStore.eventsMeta = {};
    messagingStore.mlsMeta = {};
    messagingStore.mlsCredential = null;
    messagingStore.mlsDiagnosticEvents = [];
    messagingStore.selectedConversationId = null;
    messagingStore.typingUsers = [];
    messagingStore.error = '';
  }
});

// (Removed local getOtherUserName; using shared util)

// Add calculated fields after store creation to avoid circular reference
messagingStore.selectedConversation = vanX.calc(() => {
  if (!messagingStore.selectedConversationId) return null;
  return messagingStore.conversations.find(c => c.id === messagingStore.selectedConversationId) || null;
});

messagingStore.currentMessages = vanX.calc(() => {
  if (!messagingStore.selectedConversationId) return [];
  return messagingStore.messagesByConversation[messagingStore.selectedConversationId] || [];
});

messagingStore.selectedConversationName = vanX.calc(() => {
  const id = messagingStore.selectedConversationId;
  if (!id) return '';
  const conv = messagingStore.conversationsById?.[id];
  return conv?.displayName || '';
});

  // Plain reactive projection for the sidebar, avoids Proxy aliasing
messagingStore.sidebarItems = vanX.calc(() => {
  const q = (messagingStore.searchQuery || '').toLowerCase();
  const ids = messagingStore.conversationIds || [];
  const byId = messagingStore.conversationsById || {};
  const items = ids.map(id => {
      const conv = byId[id];
      const item = conv ? {
        id: String(conv.id),
        name: conv.displayName || '',
        time: conv.lastTime || conv.last_message_created_at || conv.updated_at || conv.created_at || null,
        ts: conv.lastTs || 0,
        unread: typeof conv.my_unread_count === 'number' ? conv.my_unread_count : 0
      } : null;
      return item;
    }).filter(Boolean);
    const filtered = q ? items.filter(it => (it.name || '').toLowerCase().includes(q)) : items;
    filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return filtered;
  });

// filteredConversations deprecated; use sidebarItems for filter/sort/projection

export const deriveMlsDiagnostics = (conversationId) => {
  const key = conversationId != null ? String(conversationId) : null;
  const conversation = key ? (messagingStore.conversationsById?.[key] || null) : null;
  const meta = key ? (messagingStore.mlsMeta?.[key] || {}) : {};
  const credential = messagingStore.mlsCredential || null;
  const eventsSource = messagingStore.mlsDiagnosticEvents || [];
  const events = key
    ? eventsSource.filter(event => !event.conversationId || event.conversationId === key)
    : eventsSource;

  const encryptionMode = conversation?.encryptionMode ?? conversation?.encryption_mode ?? null;
  const history = meta.historySharing ?? conversation?.history_sharing ?? conversation?.history_sharing_enabled ?? null;
  const epoch = meta.epoch ?? meta.lastSentEpoch ?? conversation?.last_message_epoch ?? conversation?.mls_epoch ?? null;
  const ciphersuite = meta.ciphersuite ?? conversation?.mlsCiphersuite ?? conversation?.mls_ciphersuite ?? null;

  let credentialStatus = 'unknown';
  let credentialExpiresAt = null;
  if (credential?.expiresAt) {
    const expTs = Date.parse(credential.expiresAt);
    if (Number.isFinite(expTs)) {
      credentialExpiresAt = expTs;
      const now = Date.now();
      credentialStatus = expTs <= now
        ? 'expired'
        : ((expTs - now) <= (7 * 24 * 60 * 60 * 1000) ? 'expiring' : 'valid');
    }
  }

  return {
    conversationId: key,
    conversation,
    meta,
    credential,
    epoch,
    ciphersuite,
    encryptionMode,
    historySharingEnabled: history == null ? null : Boolean(history),
    credentialStatus,
    credentialExpiresAt,
    lastUpdatedAt: meta.lastUpdatedAt ?? null,
    events
  };
};

export default messagingStore;

// Expose for debugging in browser (dev tools)
try {
  if (typeof window !== 'undefined') {
    window.__messagingStore = messagingStore;
    window.messagingStore = messagingStore;
  }
} catch {}
