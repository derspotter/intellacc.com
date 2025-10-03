// frontend/src/services/signalAdapter.js
// Thin adapter to route messaging through Signal sessions when enabled

import signalSessionManager from './signalSessionManager.js';

const signalAdapter = {
  isSignalEnabled(conversation) {
    return conversation && conversation.encryptionMode === 'signal';
  },

  async enableSignalForConversation(conversation, peerUserId) {
    if (!conversation) throw new Error('conversation required');
    await signalSessionManager.ensureSession(peerUserId);
    // Caller should persist encryptionMode in store
    return true;
  },

  async encrypt(conversationId, peerUserId, plaintext) {
    const msg = await signalSessionManager.encrypt(conversationId, plaintext, peerUserId);
    return msg;
  },

  async decrypt(conversationId, envelope, peerUserId) {
    return await signalSessionManager.decrypt(conversationId, envelope, peerUserId);
  }
};

export default signalAdapter;

