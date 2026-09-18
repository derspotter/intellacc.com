// Private assistant conversations (AI DMs and the per-post AI drawer).
//
// History is stored separately from MLS user-to-user conversations. The
// application server and chosen provider process this private AI history.
// Every send is guarded per conversation and made idempotent through
// ai_conversation_requests so a retried request can never be billed twice.
const db = require('../../db');
const { buildPostVisibilityClauseForAlias } = require('../../utils/postVisibility');
const providers = require('./providers');
const { loadCredentials } = require('./aiSettingsService');
const { BUDGET, AiBudgetError, reserve } = require('./aiBudgetService');
const { PROMPT_LIMITS, clip, buildPrivateSystemPrompt, buildPrivateTurns } = require('./prompts');

const { AiProviderError } = providers;
const LIST_LIMIT = 50;
const MESSAGE_PAGE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AiRequestError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AiRequestError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const toConversation = (row) => ({ id: row.id, title: row.title, post_id: row.post_id });
const toMessage = (row) => ({
  id: row.id,
  role: row.role,
  content: row.content,
  model: row.model || null,
  status: row.status || 'ok',
  error_code: row.error_code || null,
  created_at: row.created_at
});

const parseId = (value) => {
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
};

// A post is usable as context only if the owner can see it; group posts
// additionally require membership.
const loadVisiblePost = async (client, postId, viewerId) => {
  const result = await client.query(
    `WITH RECURSIVE chain AS (
       SELECT p.*, 0 AS ai_level FROM posts p WHERE p.id = $1
       UNION ALL
       SELECT p.*, c.ai_level + 1 FROM posts p JOIN chain c ON p.id = c.parent_id WHERE c.ai_level < 128
     )
     SELECT p.id, p.parent_id, p.content, p.community_group_id, u.username,
       (u.deleted_at IS NULL AND ${buildPostVisibilityClauseForAlias('p', '$2')}
       AND (p.community_group_id IS NULL OR EXISTS (
         SELECT 1 FROM community_group_members m JOIN community_groups g ON g.id = m.group_id
         WHERE m.group_id = p.community_group_id AND m.user_id = $2 AND g.removed_at IS NULL))) AS visible
     FROM chain p JOIN users u ON u.id = p.user_id ORDER BY p.ai_level`,
    [postId, viewerId]
  );
  const rows = result.rows;
  if (!rows.length || rows.some((row) => !row.visible) || rows[rows.length - 1].parent_id) return null;
  return { ...rows[0], ancestors: rows.slice(1, PROMPT_LIMITS.threadAncestors + 1).reverse() };
};

const listConversations = async (userId) => {
  const result = await db.query(
    `SELECT id, title, post_id, updated_at FROM ai_conversations
     WHERE user_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2`,
    [userId, LIST_LIMIT]
  );
  return result.rows.map((row) => ({ id: row.id, title: row.title, post_id: row.post_id, updated_at: row.updated_at }));
};

const createConversation = async (userId, { postId } = {}) => {
  let post = null;
  if (postId !== undefined && postId !== null) {
    const id = parseId(postId);
    if (!id) throw new AiRequestError(400, 'bad_request', 'postId must be a positive integer');
    post = await loadVisiblePost(db, id, userId);
    if (!post) throw new AiRequestError(404, 'not_found', 'Post not found');
  }
  const title = post ? `Post by @${post.username}` : null;
  const result = await db.query(
    'INSERT INTO ai_conversations (user_id, post_id, title) VALUES ($1, $2, $3) RETURNING id, title, post_id',
    [userId, post ? post.id : null, title]
  );
  return toConversation(result.rows[0]);
};

const getConversation = async (userId, conversationId) => {
  const id = parseId(conversationId);
  if (!id) return null;
  const conv = (await db.query(
    'SELECT id, title, post_id FROM ai_conversations WHERE id = $1 AND user_id = $2',
    [id, userId]
  )).rows[0];
  if (!conv) return null;
  const messages = (await db.query(
    `SELECT * FROM (
       SELECT id, role, content, model, status, error_code, created_at FROM ai_messages
       WHERE conversation_id = $1 AND status <> 'pending' ORDER BY id DESC LIMIT $2
     ) recent ORDER BY id ASC`,
    [id, MESSAGE_PAGE]
  )).rows;
  return { conversation: toConversation(conv), messages: messages.map(toMessage) };
};

// Returns 'deleted' | 'not_found' | 'busy'. Deletion never interrupts a
// running generation (its result would otherwise be written into nothing).
const deleteConversation = async (userId, conversationId) => {
  const id = parseId(conversationId);
  if (!id) return 'not_found';
  const deleted = await db.query(
    `DELETE FROM ai_conversations WHERE id = $1 AND user_id = $2
       AND (generation_request_id IS NULL OR generation_started_at < NOW() - ($3 * INTERVAL '1 second'))
     RETURNING id`,
    [id, userId, BUDGET.staleGenerationSeconds]
  );
  if (deleted.rows.length) return 'deleted';
  const exists = await db.query('SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  return exists.rows.length ? 'busy' : 'not_found';
};

const withTransaction = async (callback) => {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep original error */ }
    throw error;
  } finally {
    client.release();
  }
};

const loadMessagesByIds = async (client, ids) => {
  const result = await client.query(
    'SELECT id, role, content, model, status, error_code, created_at FROM ai_messages WHERE id = ANY($1::int[]) ORDER BY id',
    [ids.filter(Boolean)]
  );
  return result.rows.map(toMessage);
};

const failRequest = (client, { conversationId, requestId, userMessageId, code }) => Promise.all([
  client.query('UPDATE ai_messages SET status = $2, error_code = $3 WHERE id = $1', [userMessageId, 'failed', code]),
  client.query(
    `UPDATE ai_conversation_requests SET status = 'failed', error_code = $3, updated_at = NOW()
     WHERE conversation_id = $1 AND request_id = $2`,
    [conversationId, requestId, code]
  ),
  client.query(
    `UPDATE ai_conversations SET generation_request_id = NULL, generation_started_at = NULL
     WHERE id = $1 AND generation_request_id = $2`,
    [conversationId, requestId]
  )
]);

const errorCodeOf = (error) => (error && typeof error.code === 'string' ? error.code : 'internal');

// Phase 1 (transaction): ownership, idempotency, concurrency, budget, persist
// the user turn and claim the conversation. Phase 2 (no transaction held):
// provider call. Phase 3 (transaction): persist the outcome.
const sendMessage = async (userId, conversationId, { message, requestId } = {}, { complete = providers.complete } = {}) => {
  const id = parseId(conversationId);
  if (!id) throw new AiRequestError(404, 'not_found', 'Conversation not found');
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw new AiRequestError(400, 'bad_request', 'message is required');
  if (text.length > PROMPT_LIMITS.userMessageChars) throw new AiRequestError(400, 'bad_request', `message must be at most ${PROMPT_LIMITS.userMessageChars} characters`);
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) throw new AiRequestError(400, 'bad_request', 'requestId must be a UUID');

  const staleSeconds = BUDGET.staleGenerationSeconds;
  const claim = await withTransaction(async (client) => {
    const conv = (await client.query(
      `SELECT id, user_id, post_id, title, generation_request_id,
              (generation_started_at IS NOT NULL AND generation_started_at < NOW() - ($3 * INTERVAL '1 second')) AS generation_stale
       FROM ai_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId, staleSeconds]
    )).rows[0];
    if (!conv) throw new AiRequestError(404, 'not_found', 'Conversation not found');

    const existing = (await client.query(
      `SELECT status, user_message_id, assistant_message_id, error_code,
              (updated_at < NOW() - ($3 * INTERVAL '1 second')) AS stale
       FROM ai_conversation_requests WHERE conversation_id = $1 AND request_id = $2`,
      [id, requestId, staleSeconds]
    )).rows[0];
    if (existing) {
      if (existing.status === 'succeeded') {
        const messages = await loadMessagesByIds(client, [existing.user_message_id, existing.assistant_message_id]);
        return { replay: { messages } };
      }
      if (existing.status === 'running' && !existing.stale) {
        throw new AiRequestError(409, 'in_progress', 'This request is still being generated');
      }
      if (existing.status === 'running') {
        // Crashed mid-generation: ambiguous, never re-run the paid call.
        await failRequest(client, { conversationId: id, requestId, userMessageId: existing.user_message_id, code: 'interrupted' });
      }
      return { failure: new AiRequestError(409, 'request_failed', 'This request failed. You can start a new attempt, which may use more provider credits.', {
        errorCode: existing.status === 'running' ? 'interrupted' : existing.error_code || 'failed'
      }) };
    }

    if (conv.generation_request_id && !conv.generation_stale) {
      throw new AiRequestError(409, 'busy', 'The assistant is still answering in this conversation');
    }
    if (conv.generation_request_id) {
      const stale = (await client.query(
        'SELECT user_message_id FROM ai_conversation_requests WHERE conversation_id = $1 AND request_id = $2',
        [id, conv.generation_request_id]
      )).rows[0];
      await failRequest(client, { conversationId: id, requestId: conv.generation_request_id, userMessageId: stale?.user_message_id ?? null, code: 'interrupted' });
    }

    const credentials = await loadCredentials(userId, client);
    if (!credentials) throw new AiRequestError(400, 'not_configured', 'Add an AI provider key in Settings first');
    if (!providers.isValidModel(credentials.model)) throw new AiRequestError(400, 'invalid_model', 'Set a model id in your AI settings first');
    await reserve(client, userId, 'private');

    const userMessage = (await client.query(
      `INSERT INTO ai_messages (conversation_id, role, content, status, request_id)
       VALUES ($1, 'user', $2, 'pending', $3) RETURNING id, role, content, model, status, error_code, created_at`,
      [id, text, requestId]
    )).rows[0];
    await client.query(
      `INSERT INTO ai_conversation_requests (conversation_id, request_id, status, user_message_id)
       VALUES ($1, $2, 'running', $3)`,
      [id, requestId, userMessage.id]
    );
    await client.query(
      'UPDATE ai_conversations SET generation_request_id = $2, generation_started_at = NOW() WHERE id = $1',
      [id, requestId]
    );

    const history = (await client.query(
      `SELECT * FROM (
         SELECT id, role, content FROM ai_messages
         WHERE conversation_id = $1 AND status = 'ok' ORDER BY id DESC LIMIT $2
       ) recent ORDER BY id ASC`,
      [id, PROMPT_LIMITS.historyMessages]
    )).rows;
    const post = conv.post_id ? await loadVisiblePost(client, conv.post_id, userId) : null;
    return { credentials, userMessage, history, post, title: conv.title };
  });

  if (claim.replay) return claim.replay;
  if (claim.failure) throw claim.failure;

  const { credentials, userMessage, history, post } = claim;
  let completion;
  try {
    completion = await complete({
      provider: credentials.provider,
      model: credentials.model,
      apiKey: credentials.apiKey,
      system: buildPrivateSystemPrompt({ post }),
      messages: buildPrivateTurns(history, text)
    });
  } catch (error) {
    const code = errorCodeOf(error);
    await withTransaction((client) => failRequest(client, { conversationId: id, requestId, userMessageId: userMessage.id, code }));
    if (error instanceof AiProviderError) throw new AiRequestError(502, code, error.message);
    console.error('[AI] private completion failed:', error?.message || error);
    throw new AiRequestError(500, 'internal', 'The assistant could not answer');
  }

  return withTransaction(async (client) => {
    const active = await client.query(
      'SELECT id FROM ai_conversations WHERE id = $1 AND generation_request_id = $2 FOR UPDATE', [id, requestId]
    );
    if (!active.rows.length) throw new AiRequestError(409, 'request_failed', 'This answer arrived after the request expired.');
    const assistant = (await client.query(
      `INSERT INTO ai_messages (conversation_id, role, content, model, status, request_id)
       VALUES ($1, 'assistant', $2, $3, 'ok', $4) RETURNING id, role, content, model, status, error_code, created_at`,
      [id, completion.text, completion.model, requestId]
    )).rows[0];
    await client.query("UPDATE ai_messages SET status = 'ok' WHERE id = $1", [userMessage.id]);
    await client.query(
      `UPDATE ai_conversation_requests SET status = 'succeeded', assistant_message_id = $3, updated_at = NOW()
       WHERE conversation_id = $1 AND request_id = $2`,
      [id, requestId, assistant.id]
    );
    await client.query(
      `UPDATE ai_conversations SET generation_request_id = NULL, generation_started_at = NULL,
         updated_at = NOW(), title = COALESCE(title, $2) WHERE id = $1`,
      [id, clip(text.replace(/\s+/g, ' '), 80)]
    );
    return { messages: [toMessage({ ...userMessage, status: 'ok' }), toMessage(assistant)] };
  });
};

// Settings test: a tiny inference with the saved credentials.
const testSettings = async (userId, { complete = providers.complete } = {}) => {
  const { credentials, reservationId } = await withTransaction(async (client) => {
    const loaded = await loadCredentials(userId, client);
    if (!loaded) throw new AiRequestError(400, 'not_configured', 'Save a provider key first');
    if (!providers.isValidModel(loaded.model)) throw new AiRequestError(400, 'invalid_model', 'Set a model id first');
    const reservationId = await reserve(client, userId, 'test');
    return { credentials: loaded, reservationId };
  });
  try {
    await complete({
      provider: credentials.provider,
      model: credentials.model,
      apiKey: credentials.apiKey,
      system: 'Reply with the single word OK.',
      messages: [{ role: 'user', content: 'Connection test. Reply with OK.' }],
      maxTokens: 16
    });
  } catch (error) {
    if (error instanceof AiProviderError) throw new AiRequestError(502, error.code, error.message);
    throw error;
  } finally {
    await db.query('UPDATE ai_usage_events SET active_until = NULL WHERE id = $1', [reservationId]);
  }
  return { ok: true };
};

module.exports = {
  AiRequestError,
  AiBudgetError,
  listConversations,
  createConversation,
  getConversation,
  deleteConversation,
  sendMessage,
  testSettings
};
