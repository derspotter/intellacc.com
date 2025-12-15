// frontend/src/utils/messagingUtils.js
// Shared helpers for messaging UI/service

/**
 * Compute a stable participant pair key for a conversation.
 * Prefers other_user_id when available; otherwise uses sorted participant ids.
 * @param {Object} conv
 * @param {number|string|null} currentUserId
 * @returns {string}
 */
// Note: pair key was used during early dedupe; with unique conversation IDs,
// we rely on `id` exclusively and keep this helper removed from hot paths.

/**
 * Get the other user's display name for a conversation.
 * @param {Object} conv
 * @param {number|string|null} currentUserId
 * @returns {string}
 */
export function getOtherUserName(conv, currentUserId) {
  if (!conv) return 'Unknown';
  if (conv.other_user_username) return conv.other_user_username;
  const uid = currentUserId != null ? Number(currentUserId) : NaN;
  try {
    return conv.participant_1 === uid ? conv.participant_2_username : conv.participant_1_username;
  } catch {
    return 'Unknown';
  }
}

/**
 * Build a snapshot array for sidebar rendering.
 * Dedupes exact duplicates by id, keeping the newest by time.
 * @param {Array<Object>} list Conversations list (normalized with id, participant fields)
 * @param {number|string|null} currentUserId
 * @returns {Array<{id:string,key:string,name:string,time:string|null,unread:number}>}
 */
// buildConversationSnapshot removed; sidebar renders from store projection.

/**
 * Normalize a raw conversation from API for store ingestion.
 * Returns a shape with stable id (string), displayName, and lastTime.
 */
export function normalizeConversation(conv, currentUserId) {
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
  normalized.encryption_mode = encryptionMode;
  normalized.mls_migration_eligible = migrationEligible;
  return normalized;
}
