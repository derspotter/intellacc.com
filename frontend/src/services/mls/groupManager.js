// frontend/src/services/mls/groupManager.js
// Helpers wrapping CoreCrypto lifecycle operations for conversations.

import api from '../api.js';
import {
  ensureMlsBootstrap,
  ensureConversationCreated,
  addClientsToConversation,
  commitPendingProposals,
  DEFAULT_MLS_CIPHERSUITE,
  base64ToUint8
} from './coreCryptoClient.js';

const fetchKeyPackages = async (userId, { limit = 5, ciphersuite = DEFAULT_MLS_CIPHERSUITE } = {}) => {
  if (!userId) return [];
  try {
    const response = await api.mls.getKeyPackages(userId, { limit, ciphersuite });
    const items = response?.items || [];
    return items
      .map((item) => ({
        clientId: item.clientId,
        credentialType: item.credentialType,
        keyPackage: base64ToUint8(item.keyPackage)
      }))
      .filter((item) => item.keyPackage);
  } catch (error) {
    console.warn('[MLS] Failed to fetch key packages for user', userId, error);
    return [];
  }
};

const uniqueNumbers = (values) => {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    if (seen.has(numeric)) continue;
    seen.add(numeric);
    output.push(numeric);
  }
  return output;
};

export const ensureConversationLifecycle = async (conversationId, participantUserIds = []) => {
  if (!conversationId) return;
  await ensureMlsBootstrap();
  await ensureConversationCreated(conversationId);

  const participantIds = uniqueNumbers(participantUserIds).filter((id) => id > 0);
  if (participantIds.length === 0) return;

  for (const userId of participantIds) {
    const keyPackages = await fetchKeyPackages(userId);
    if (!keyPackages.length) {
      console.warn('[MLS] No key packages available for user', userId);
      continue;
    }
    try {
      const bytes = keyPackages.map((item) => item.keyPackage);
      await addClientsToConversation(conversationId, bytes);
    } catch (error) {
      console.warn('[MLS] Failed to add user to conversation', { conversationId, userId }, error);
    }
  }

  try {
    await commitPendingProposals(conversationId);
  } catch (error) {
    console.warn('[MLS] commitPendingProposals failed', error);
  }
};

export const ensureConversationBootstrap = async (conversationId) => {
  if (!conversationId) return;
  await ensureMlsBootstrap();
  await ensureConversationCreated(conversationId);
};
