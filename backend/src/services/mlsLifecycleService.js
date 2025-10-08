// backend/src/services/mlsLifecycleService.js
// Utilities to coordinate MLS lifecycle operations with the frontend transport.

const lifecycleHooks = {
  ensureConversationCreated: null,
  addClientsToConversation: null,
  removeClientsFromConversation: null,
  commitPendingProposals: null,
  enableHistorySharing: null,
  disableHistorySharing: null
};

function registerLifecycleHooks(hooks = {}) {
  Object.assign(lifecycleHooks, hooks);
}

const validateConversationId = (conversationId) => {
  const numeric = Number(conversationId);
  if (!Number.isInteger(numeric)) {
    throw new Error('conversationId must be an integer');
  }
  return numeric;
};

async function ensureConversationCreated(conversationId) {
  if (typeof lifecycleHooks.ensureConversationCreated === 'function') {
    await lifecycleHooks.ensureConversationCreated(conversationId);
  }
}

async function addMembers(conversationId, keyPackages = []) {
  if (typeof lifecycleHooks.addClientsToConversation === 'function' && keyPackages.length) {
    await lifecycleHooks.addClientsToConversation(conversationId, keyPackages);
  }
}

async function removeMembers(conversationId, clientIds = []) {
  if (typeof lifecycleHooks.removeClientsFromConversation === 'function' && clientIds.length) {
    await lifecycleHooks.removeClientsFromConversation(conversationId, clientIds);
  }
}

async function commitPending(conversationId) {
  if (typeof lifecycleHooks.commitPendingProposals === 'function') {
    await lifecycleHooks.commitPendingProposals(conversationId);
  }
}

async function enableHistory(conversationId) {
  if (typeof lifecycleHooks.enableHistorySharing === 'function') {
    await lifecycleHooks.enableHistorySharing(conversationId);
  }
}

async function disableHistory(conversationId) {
  if (typeof lifecycleHooks.disableHistorySharing === 'function') {
    await lifecycleHooks.disableHistorySharing(conversationId);
  }
}

module.exports = {
  validateConversationId,
  registerLifecycleHooks,
  ensureConversationCreated,
  addMembers,
  removeMembers,
  commitPending,
  enableHistory,
  disableHistory
};
