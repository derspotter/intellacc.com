// frontend-solid/src/store/messagingStore.js
// SolidJS port of the VanJS messaging store (frontend/src/stores/messagingStore.js).
//
// Goals:
// - Keep the same state shape and (mostly) the same method surface as the master store
// - Use Solid primitives only (no van/vanX)
// - Remain safe to import even when localStorage/atob aren't available (SSR/tests)

import { batch, createMemo, createRoot } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';

function safeAtob(input) {
  try {
    if (typeof atob === 'function') return atob(input);
    if (typeof globalThis?.atob === 'function') return globalThis.atob(input);
  } catch {}
  return null;
}

function safeGetTokenUserId() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const token = localStorage.getItem('token');
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const decoded = safeAtob(parts[1]);
    if (!decoded) return null;
    const payload = JSON.parse(decoded);
    const id = payload?.userId;
    return id != null ? Number(id) : null;
  } catch {
    return null;
  }
}

function getOtherUserName(conv, currentUserId) {
  if (!conv) return 'Unknown';
  if (conv.other_user_username) return conv.other_user_username;
  const uid = currentUserId != null ? Number(currentUserId) : NaN;
  try {
    return conv.participant_1 === uid ? conv.participant_2_username : conv.participant_1_username;
  } catch {
    return 'Unknown';
  }
}

function normalizeConversation(conv, currentUserId) {
  if (!conv) return null;
  const id = String(conv?.id ?? conv?.conversation_id ?? '');
  if (!id) return null;
  const displayName = getOtherUserName(conv, currentUserId);
  const lastTime = conv.last_message_created_at || conv.last_message_at || conv.updated_at || conv.created_at || null;
  const lastTs = lastTime ? Date.parse(lastTime) || 0 : 0;
  const encryptionMode = (conv.encryption_mode || conv.encryptionMode || 'legacy').toLowerCase();
  const rawEligible = conv.mls_migration_eligible ?? conv.mlsMigrationEligible;
  const migrationEligible = rawEligible == null ? (encryptionMode !== 'mls') : Boolean(rawEligible);

  const normalized = {
    ...conv,
    id,
    displayName,
    lastTime,
    lastTs,
    encryptionMode,
    mlsMigrationEligible: migrationEligible
  };
  // Keep backend-style keys in sync for mixed callers.
  normalized.encryption_mode = encryptionMode;
  normalized.mls_migration_eligible = migrationEligible;
  return normalized;
}

const sortIdsByTs = (byId, ids) =>
  ids.sort((a, b) => ((byId[b]?.lastTs || 0) - (byId[a]?.lastTs || 0)));

function createInitialState() {
  return {
    // Core state
    conversations: [],
    conversationsById: {},
    conversationIds: [],
    currentUserId: null,
    messagesMeta: {},
    messagesByConversation: {},
    selectedConversationId: null,
    conversationsLoading: false,
    messagesLoading: false,
    error: '',

    // MLS E2EE state
    mlsInitialized: false,
    mlsGroups: [],
    mlsGroupsById: {},
    selectedMlsGroupId: null,
    mlsMessages: {},
    showMlsMode: true,
    showCreateMlsGroup: false,
    mlsInviteUserId: '',
    showMlsInvite: false,
    pendingWelcomes: [],

    // Direct Messages (DM) state
    directMessages: [],
    dmSearchQuery: '',
    dmSearchResults: [],
    showDmModal: false,

    // Fingerprint warnings (TOFU security alerts)
    fingerprintWarnings: [],

    // Typing indicators
    typingUsers: [],

    // New conversation form
    showNewConversation: false,
    newConversationUser: '',
    newMessage: '',

    // Search
    searchQuery: '',

    // User name cache
    userNameCache: {}
  };
}

const messagingStore = createRoot(() => {
  const [state, setState] = createStore(createInitialState());

  // ---- Computed projections (Solid createMemo + getters for value-style access) ----

  const selectedConversationMemo = createMemo(() => {
    const id = state.selectedConversationId;
    if (!id) return null;
    return state.conversations.find((c) => String(c.id) === String(id)) || null;
  });

  const currentMessagesMemo = createMemo(() => {
    const id = state.selectedConversationId;
    if (!id) return [];
    return state.messagesByConversation[String(id)] || [];
  });

  const selectedConversationNameMemo = createMemo(() => {
    const id = state.selectedConversationId;
    if (!id) return '';
    const conv = state.conversationsById?.[String(id)];
    return conv?.displayName || '';
  });

  const sidebarItemsMemo = createMemo(() => {
    const q = (state.searchQuery || '').toLowerCase();
    const ids = state.conversationIds || [];
    const byId = state.conversationsById || {};
    const items = ids.map((id) => {
      const conv = byId[id];
      if (!conv) return null;
      return {
        id: String(conv.id),
        name: conv.displayName || '',
        time: conv.lastTime || conv.last_message_created_at || conv.updated_at || conv.created_at || null,
        ts: conv.lastTs || 0,
        unread: typeof conv.my_unread_count === 'number' ? conv.my_unread_count : 0
      };
    }).filter(Boolean);
    const filtered = q ? items.filter((it) => (it.name || '').toLowerCase().includes(q)) : items;
    filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return filtered;
  });

  const selectedMlsGroupMemo = createMemo(() => {
    const id = state.selectedMlsGroupId;
    if (!id) return null;
    return state.mlsGroupsById?.[String(id)] || null;
  });

  const currentMlsMessagesMemo = createMemo(() => {
    const id = state.selectedMlsGroupId;
    if (!id) return [];
    return state.mlsMessages[String(id)] || [];
  });

  const mlsSidebarItemsMemo = createMemo(() => {
    const q = (state.searchQuery || '').toLowerCase();
    const groups = state.mlsGroups || [];
    const items = groups.map((g) => ({
      id: g.group_id,
      name: g.name || 'Unnamed Group',
      time: g.created_at || null,
      ts: g.created_at ? Date.parse(g.created_at) : 0,
      isMls: true,
      isDm: g.group_id?.startsWith('dm_') || false
    }));
    const filtered = q ? items.filter((it) => (it.name || '').toLowerCase().includes(q)) : items;
    filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return filtered;
  });

  const dmSidebarItemsMemo = createMemo(() => {
    const q = (state.searchQuery || '').toLowerCase();
    const dms = state.directMessages || [];
    const items = dms.map((dm) => ({
      id: dm.group_id,
      name: dm.other_username || `User ${dm.other_user_id}`,
      otherUserId: dm.other_user_id,
      time: dm.created_at || null,
      ts: dm.created_at ? Date.parse(dm.created_at) : 0,
      isDm: true
    }));
    const filtered = q ? items.filter((it) => (it.name || '').toLowerCase().includes(q)) : items;
    filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return filtered;
  });

  // ---- Actions (mirrors master store methods) ----

  function setCurrentUserId(userId) {
    setState('currentUserId', userId != null ? Number(userId) : null);
  }

  function upsertConversations(rawList) {
    const currentUserId = (state.currentUserId != null) ? state.currentUserId : safeGetTokenUserId();
    const byId = { ...(state.conversationsById || {}) };

    for (const raw of rawList || []) {
      const norm = normalizeConversation(raw, currentUserId);
      if (!norm) continue;
      const prev = byId[norm.id];
      byId[norm.id] = prev ? { ...prev, ...norm } : norm;
    }

    const ids = Object.values(byId).map((c) => String(c.id));
    sortIdsByTs(byId, ids);

    batch(() => {
      setState('conversationsById', byId);
      setState('conversationIds', ids);
      setState('conversations', ids.map((id) => byId[id]));
    });
  }

  function upsertConversation(raw) {
    const currentUserId = (state.currentUserId != null) ? state.currentUserId : safeGetTokenUserId();
    const norm = normalizeConversation(raw, currentUserId);
    if (!norm) return;

    const byId = { ...(state.conversationsById || {}) };
    byId[norm.id] = byId[norm.id] ? { ...byId[norm.id], ...norm } : norm;

    const set = new Set(state.conversationIds || []);
    set.add(norm.id);
    const ids = Array.from(set);
    sortIdsByTs(byId, ids);

    batch(() => {
      setState('conversationsById', byId);
      setState('conversationIds', ids);
      setState('conversations', ids.map((id) => byId[id]));
    });
  }

  function setConversations(conversations) {
    upsertConversations(conversations);
  }

  function addConversation(conversation) {
    const id = String(conversation?.id ?? conversation?.conversation_id ?? '');
    if (!id) return;
    upsertConversation({ ...conversation, id });
  }

  function updateConversation(conversationId, updates) {
    const id = String(conversationId ?? '');
    if (!id) return;

    const existing = state.conversationsById?.[id] || state.conversations.find((c) => String(c.id) === id);
    if (!existing) return;

    const next = { ...existing, ...(updates || {}) };
    const lt = updates?.last_message_created_at || updates?.last_message_at || updates?.updated_at || updates?.created_at;
    if (lt) {
      next.lastTime = lt;
      next.lastTs = Date.parse(lt) || next.lastTs || 0;
    }
    if (!next.displayName && existing.displayName) next.displayName = existing.displayName;

    batch(() => {
      setState('conversationsById', id, next);
      setState('conversations', (list) => list.map((c) => (String(c.id) === id ? next : c)));
    });
  }

  function incrementUnread(conversationId, delta = 1) {
    const id = String(conversationId ?? '');
    if (!id) return;

    const myId = safeGetTokenUserId();
    if (myId == null) return;

    const conv = state.conversationsById?.[id] || state.conversations.find((c) => String(c.id) === id);
    if (!conv) return;

    const field = (conv.participant_1 === myId) ? 'unread_count_participant_1' : 'unread_count_participant_2';
    const current = conv[field] || 0;
    const myUnread = (conv.my_unread_count || 0) + delta;

    const next = { ...conv, [field]: current + delta, my_unread_count: myUnread };
    batch(() => {
      setState('conversationsById', id, next);
      setState('conversations', (list) => list.map((c) => (String(c.id) === id ? next : c)));
    });
  }

  function setMessages(conversationId, messages) {
    const key = String(conversationId ?? '');
    if (!key) return;
    const list = Array.isArray(messages) ? [...messages] : [];
    const now = Date.now();
    batch(() => {
      setState('messagesByConversation', key, list);
      setState('messagesMeta', key, { lastFetchedTs: now });
    });
  }

  function addMessage(conversationId, message) {
    const key = String(conversationId ?? '');
    if (!key || !message) return false;

    const existing = state.messagesByConversation[key] || [];
    if (existing.some((m) => m.id === message.id)) return false;

    const newMessages = [...existing];
    const insertIndex = newMessages.findIndex((m) => new Date(m.created_at) > new Date(message.created_at));
    if (insertIndex === -1) newMessages.push(message);
    else newMessages.splice(insertIndex, 0, message);

    setState('messagesByConversation', key, newMessages);
    return true;
  }

  function updateMessage(messageId, updates) {
    if (messageId == null) return;
    for (const [conversationId, messages] of Object.entries(state.messagesByConversation || {})) {
      const idx = (messages || []).findIndex((m) => m.id === messageId);
      if (idx === -1) continue;
      setState('messagesByConversation', conversationId, idx, { ...messages[idx], ...(updates || {}) });
      break;
    }
  }

  function removeMessage(messageId) {
    if (messageId == null) return;
    for (const [conversationId, messages] of Object.entries(state.messagesByConversation || {})) {
      const filtered = (messages || []).filter((m) => m.id !== messageId);
      if (filtered.length === (messages || []).length) continue;
      setState('messagesByConversation', conversationId, filtered);
      break;
    }
  }

  function markMessagesAsRead(messageIds) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    const now = new Date().toISOString();
    const ids = new Set(messageIds);

    batch(() => {
      for (const [conversationId, messages] of Object.entries(state.messagesByConversation || {})) {
        let updated = false;
        const next = (messages || []).map((m) => {
          if (!ids.has(m.id)) return m;
          updated = true;
          return { ...m, read_at: now };
        });
        if (updated) setState('messagesByConversation', conversationId, next);
      }
    });
  }

  function selectConversation(conversationId) {
    const id = String(conversationId ?? '');
    batch(() => {
      setState('selectedConversationId', id || null);
      setState('typingUsers', []);
    });
  }

  function clearSelection() {
    batch(() => {
      setState('selectedConversationId', null);
      setState('typingUsers', []);
    });
  }

  function setTypingUsers(userIds) {
    setState('typingUsers', Array.isArray(userIds) ? [...userIds] : []);
  }

  function addTypingUser(userId) {
    if (userId == null) return;
    if (state.typingUsers.includes(userId)) return;
    setState('typingUsers', (prev) => [...prev, userId]);
  }

  function removeTypingUser(userId) {
    if (userId == null) return;
    setState('typingUsers', (prev) => prev.filter((id) => id !== userId));
  }

  function setConversationsLoading(loading) {
    setState('conversationsLoading', Boolean(loading));
  }

  function setMessagesLoading(loading) {
    setState('messagesLoading', Boolean(loading));
  }

  function setError(error) {
    setState('error', error || '');
  }

  function clearError() {
    setState('error', '');
  }

  function setShowNewConversation(show) {
    setState('showNewConversation', Boolean(show));
  }

  function setNewConversationUser(user) {
    setState('newConversationUser', user || '');
  }

  function setNewMessage(message) {
    setState('newMessage', message || '');
  }

  function setSearchQuery(query) {
    setState('searchQuery', query || '');
  }

  // MLS actions
  function setMlsInitialized(initialized) {
    setState('mlsInitialized', Boolean(initialized));
  }

  function setMlsGroups(groups) {
    const list = Array.isArray(groups) ? groups : [];
    const byId = {};
    for (const g of list) {
      if (g?.group_id) byId[g.group_id] = g;
    }
    batch(() => {
      setState('mlsGroups', list);
      setState('mlsGroupsById', byId);
    });
  }

  function addMlsGroup(group) {
    if (!group?.group_id) return;
    const exists = (state.mlsGroups || []).some((g) => g.group_id === group.group_id);
    if (exists) return;
    batch(() => {
      setState('mlsGroups', (prev) => [...prev, group]);
      setState('mlsGroupsById', group.group_id, group);
    });
  }

  function selectMlsGroup(groupId) {
    batch(() => {
      setState('selectedMlsGroupId', groupId || null);
      setState('selectedConversationId', null);
    });
  }

  function setMlsMessages(groupId, messages) {
    const key = String(groupId ?? '');
    if (!key) return;
    setState('mlsMessages', key, Array.isArray(messages) ? messages : []);
  }

  function addMlsMessage(groupId, message) {
    const key = String(groupId ?? '');
    if (!key || !message) return;
    const existing = state.mlsMessages[key] || [];
    if (existing.some((m) => m.id === message.id)) return;
    setState('mlsMessages', key, [...existing, message]);
  }

  function setShowMlsMode(show) {
    setState('showMlsMode', Boolean(show));
  }

  function setShowCreateMlsGroup(show) {
    setState('showCreateMlsGroup', Boolean(show));
  }

  function setMlsInviteUserId(userId) {
    setState('mlsInviteUserId', userId || '');
  }

  function setShowMlsInvite(show) {
    setState('showMlsInvite', Boolean(show));
  }

  // DM actions
  function setDirectMessages(dms) {
    setState('directMessages', Array.isArray(dms) ? dms : []);
  }

  function setDmSearchQuery(query) {
    setState('dmSearchQuery', query || '');
  }

  function setDmSearchResults(results) {
    setState('dmSearchResults', Array.isArray(results) ? results : []);
  }

  function setShowDmModal(show) {
    const next = Boolean(show);
    batch(() => {
      setState('showDmModal', next);
      if (!next) {
        setState('dmSearchQuery', '');
        setState('dmSearchResults', []);
      }
    });
  }

  // Pending welcomes
  function setPendingWelcomes(list) {
    setState('pendingWelcomes', Array.isArray(list) ? list : []);
  }

  function addPendingWelcome(invite) {
    if (!invite || invite.id == null) return;
    const exists = (state.pendingWelcomes || []).some((item) => item.id === invite.id);
    if (exists) return;
    setState('pendingWelcomes', (prev) => [...prev, invite]);
  }

  function removePendingWelcome(inviteId) {
    if (inviteId == null) return;
    setState('pendingWelcomes', (prev) => prev.filter((item) => item.id !== inviteId));
  }

  // Fingerprint warnings (TOFU security)
  function addFingerprintWarnings(warnings) {
    if (!Array.isArray(warnings) || warnings.length === 0) return;
    const existingUserIds = new Set((state.fingerprintWarnings || []).map((w) => w.userId));
    const newWarnings = warnings.filter((w) => w && !existingUserIds.has(w.userId));
    if (newWarnings.length === 0) return;
    setState('fingerprintWarnings', (prev) => [...prev, ...newWarnings]);
  }

  function dismissFingerprintWarning(userId) {
    setState('fingerprintWarnings', (prev) => prev.filter((w) => w.userId !== userId));
  }

  function clearFingerprintWarnings() {
    setState('fingerprintWarnings', []);
  }

  // Cache helpers
  function cacheUserName(userId, username) {
    if (userId == null) return;
    setState('userNameCache', String(userId), username);
  }

  function getFingerprintWarnings() {
    return state.fingerprintWarnings || [];
  }

  function clearCache() {
    // SECURITY: Clear all potentially sensitive data from memory
    setState(reconcile(createInitialState()));
    try {
      console.log('[MessagingStore] Cache cleared - all sensitive data wiped');
    } catch {}
  }

  // ---- Public store surface ----
  return {
    state,

    // Common value-style getters (so consumers can treat this like the VanX store)
    get conversations() { return state.conversations; },
    get conversationsById() { return state.conversationsById; },
    get conversationIds() { return state.conversationIds; },
    get currentUserId() { return state.currentUserId; },
    get messagesMeta() { return state.messagesMeta; },
    get messagesByConversation() { return state.messagesByConversation; },
    get selectedConversationId() { return state.selectedConversationId; },
    get conversationsLoading() { return state.conversationsLoading; },
    get messagesLoading() { return state.messagesLoading; },
    get error() { return state.error; },

    get mlsInitialized() { return state.mlsInitialized; },
    get mlsGroups() { return state.mlsGroups; },
    get mlsGroupsById() { return state.mlsGroupsById; },
    get selectedMlsGroupId() { return state.selectedMlsGroupId; },
    get mlsMessages() { return state.mlsMessages; },
    get showMlsMode() { return state.showMlsMode; },
    get showCreateMlsGroup() { return state.showCreateMlsGroup; },
    get mlsInviteUserId() { return state.mlsInviteUserId; },
    get showMlsInvite() { return state.showMlsInvite; },
    get pendingWelcomes() { return state.pendingWelcomes; },

    get directMessages() { return state.directMessages; },
    get dmSearchQuery() { return state.dmSearchQuery; },
    get dmSearchResults() { return state.dmSearchResults; },
    get showDmModal() { return state.showDmModal; },

    get fingerprintWarnings() { return state.fingerprintWarnings; },
    get typingUsers() { return state.typingUsers; },
    get showNewConversation() { return state.showNewConversation; },
    get newConversationUser() { return state.newConversationUser; },
    get newMessage() { return state.newMessage; },
    get searchQuery() { return state.searchQuery; },
    get userNameCache() { return state.userNameCache; },

    // Computed (value-style)
    get selectedConversation() { return selectedConversationMemo(); },
    get currentMessages() { return currentMessagesMemo(); },
    get selectedConversationName() { return selectedConversationNameMemo(); },
    get sidebarItems() { return sidebarItemsMemo(); },

    get selectedMlsGroup() { return selectedMlsGroupMemo(); },
    get currentMlsMessages() { return currentMlsMessagesMemo(); },
    get mlsSidebarItems() { return mlsSidebarItemsMemo(); },
    get dmSidebarItems() { return dmSidebarItemsMemo(); },

    // Actions
    setCurrentUserId,
    upsertConversations,
    upsertConversation,
    setConversations,
    addConversation,
    updateConversation,
    incrementUnread,
    setMessages,
    addMessage,
    updateMessage,
    removeMessage,
    markMessagesAsRead,
    selectConversation,
    clearSelection,
    setTypingUsers,
    addTypingUser,
    removeTypingUser,

    setConversationsLoading,
    setMessagesLoading,
    setError,
    clearError,
    setShowNewConversation,
    setNewConversationUser,
    setNewMessage,
    setSearchQuery,

    setMlsInitialized,
    setMlsGroups,
    addMlsGroup,
    selectMlsGroup,
    setMlsMessages,
    addMlsMessage,
    setShowMlsMode,
    setShowCreateMlsGroup,
    setMlsInviteUserId,
    setShowMlsInvite,

    setDirectMessages,
    setDmSearchQuery,
    setDmSearchResults,
    setShowDmModal,

    setPendingWelcomes,
    addPendingWelcome,
    removePendingWelcome,

    addFingerprintWarnings,
    dismissFingerprintWarning,
    clearFingerprintWarnings,
    getFingerprintWarnings,

    cacheUserName,
    clearCache
  };
});

// Expose for debugging in browser
try {
  if (typeof window !== 'undefined') {
    window.__messagingStore = messagingStore;
    window.messagingStore = messagingStore;
  }
} catch {}

export default messagingStore;
