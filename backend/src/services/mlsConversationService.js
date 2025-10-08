// backend/src/services/mlsConversationService.js

const db = require('../db');

async function upsertConversation({ conversationId, creatorUserId, ciphersuite, groupInfo = null }) {
  const result = await db.query(
    `INSERT INTO mls_conversations (conversation_id, creator_user_id, ciphersuite, group_info)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (conversation_id)
     DO UPDATE SET
       creator_user_id = EXCLUDED.creator_user_id,
       ciphersuite = EXCLUDED.ciphersuite,
       group_info = COALESCE(EXCLUDED.group_info, mls_conversations.group_info),
       updated_at = NOW()
     RETURNING conversation_id, creator_user_id, ciphersuite, history_sharing_enabled, group_info, created_at, updated_at`,
    [conversationId, creatorUserId, ciphersuite, groupInfo]
  );
  return result.rows[0];
}

async function updateGroupInfo({ conversationId, groupInfo }) {
  const result = await db.query(
    `UPDATE mls_conversations
        SET group_info = $2,
            updated_at = NOW()
      WHERE conversation_id = $1
      RETURNING conversation_id, creator_user_id, ciphersuite, history_sharing_enabled, group_info, created_at, updated_at`,
    [conversationId, groupInfo]
  );
  return result.rows[0] || null;
}

async function setHistorySharing({ conversationId, enabled }) {
  const result = await db.query(
    `UPDATE mls_conversations
        SET history_sharing_enabled = $2,
            updated_at = NOW()
      WHERE conversation_id = $1
      RETURNING conversation_id, creator_user_id, ciphersuite, history_sharing_enabled, group_info, created_at, updated_at`,
    [conversationId, enabled]
  );
  return result.rows[0] || null;
}

async function getConversation(conversationId) {
  const result = await db.query(
    `SELECT conversation_id, creator_user_id, ciphersuite, history_sharing_enabled, group_info, created_at, updated_at
       FROM mls_conversations
      WHERE conversation_id = $1`,
    [conversationId]
  );
  return result.rows[0] || null;
}

module.exports = {
  upsertConversation,
  updateGroupInfo,
  setHistorySharing,
  getConversation
};
