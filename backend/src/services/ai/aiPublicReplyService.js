// Public "@ai" replies: a durable job per triggering post, claimed atomically
// by the worker, generated with the requesting author's own key, published
// at most once as a comment by the dedicated system bot.
//
// The prompt contains only the visible public ancestor chain of the trigger
// post. Private assistant history and DMs are never queried here.
const { randomUUID } = require('crypto');
const db = require('../../db');
const notificationService = require('../notificationService');
const { buildPostVisibilityClauseForAlias } = require('../../utils/postVisibility');
const providers = require('./providers');
const { isAvailable } = require('./credentialCrypto');
const { loadCredentials } = require('./aiSettingsService');
const { AiBudgetError, reserve } = require('./aiBudgetService');
const { mentionsAi } = require('./aiMentionService');
const { PROMPT_LIMITS, buildPublicSystemPrompt, buildPublicTurns, formatPublicReply } = require('./prompts');

const { AiProviderError } = providers;
const BOT_KEY = 'ai_assistant';
const LEASE_SECONDS = 180; // longer than the maximum provider timeout

const NOTICES = Object.freeze({
  unavailable: 'The AI assistant is not available on this server, so @ai was ignored.',
  not_configured: 'Add an AI provider key in your AI settings to get @ai replies. Your post was published.',
  public_replies_disabled: 'Public @ai replies are turned off in your AI settings. Your post was published.',
  invalid_model: 'Set a model id in your AI settings to get @ai replies. Your post was published.',
  group_unsupported: '@ai replies are not available inside groups. Your post was published.',
  post_unavailable: 'The post is no longer visible, so no AI reply was posted.',
  bot_missing: 'The AI reply account is not set up on this server.',
  interrupted: 'The AI reply was interrupted before it could be posted. Mention @ai in a new post to try again.',
  rate_limited: 'Your AI request limit was reached; no AI reply was posted.',
  too_many_active: 'Another AI request of yours is still running; no AI reply was posted.',
  auth: 'Your AI provider rejected the API key; no AI reply was posted.',
  model_not_found: 'Your AI provider does not know the configured model; no AI reply was posted.',
  billing: 'Your AI provider reported a billing problem; no AI reply was posted.',
  timeout: 'Your AI provider did not answer in time; no AI reply was posted.',
  queue_failed: 'Your post was published, but the AI reply could not be queued.'
});
const describeFailure = (code) => NOTICES[code] || 'The AI reply could not be generated; no AI reply was posted.';

let botCache = null;
const getBotIdentity = async (client = db) => {
  if (botCache) return botCache;
  const row = (await client.query(
    'SELECT id, username FROM users WHERE system_bot_key = $1 AND deleted_at IS NULL',
    [BOT_KEY]
  )).rows[0];
  if (row) botCache = { id: row.id, username: row.username };
  return botCache;
};
const isSystemBotUser = async (userId) => {
  const bot = await getBotIdentity();
  return Boolean(bot && bot.id === userId);
};

const recordDecline = async (postId, userId, code) => {
  await db.query(
    `INSERT INTO ai_public_reply_jobs (post_id, requester_user_id, status, error_code)
     VALUES ($1, $2, 'declined', $3) ON CONFLICT (post_id) DO NOTHING`,
    [postId, userId, code]
  );
};

// Called right after a post is created. Returns null when the post does not
// summon the assistant, otherwise { queued, notice? }. Never throws.
const enqueueForPost = async ({ postId, userId, content, isBot, repostId, communityGroupId }) => {
  if (isBot || repostId || !mentionsAi(content)) return null;
  try {
    if (await isSystemBotUser(userId)) return null;
    let code = null;
    if (!isAvailable()) code = 'unavailable';
    else if (communityGroupId) code = 'group_unsupported';
    else {
      let credentials = null;
      try {
        credentials = await loadCredentials(userId);
      } catch (error) {
        code = error instanceof AiProviderError ? error.code : 'unavailable';
      }
      if (!code) {
        if (!credentials) code = 'not_configured';
        else if (!credentials.publicReplies) code = 'public_replies_disabled';
        else if (!providers.isValidModel(credentials.model)) code = 'invalid_model';
      }
    }
    if (code) {
      await recordDecline(postId, userId, code);
      return { queued: false, notice: describeFailure(code) };
    }
    const inserted = await db.query(
      `INSERT INTO ai_public_reply_jobs (post_id, requester_user_id, status)
       VALUES ($1, $2, 'queued') ON CONFLICT (post_id) DO NOTHING RETURNING post_id`,
      [postId, userId]
    );
    return { queued: inserted.rows.length > 0 };
  } catch (error) {
    console.error('[AI] failed to queue public reply:', error?.message || error);
    return { queued: false, notice: describeFailure('queue_failed') };
  }
};

// Owner-only status for the frontend: queued | running | published | failed | declined.
const getStatus = async (userId, postId) => {
  const row = (await db.query(
    `SELECT status, error_code, reply_post_id, model, updated_at
     FROM ai_public_reply_jobs WHERE post_id = $1 AND requester_user_id = $2`,
    [postId, userId]
  )).rows[0];
  if (!row) return null;
  const failed = row.status === 'failed' || row.status === 'declined';
  return {
    status: row.status,
    reason: failed ? describeFailure(row.error_code) : null,
    errorCode: failed ? row.error_code : null,
    replyPostId: row.reply_post_id,
    model: row.model,
    updatedAt: row.updated_at
  };
};

// Visible public ancestor chain, root first, ending with the trigger post.
// Stops at the first ancestor the requester cannot see (chain broken).
const loadThread = async (client, postId, viewerId) => {
  const result = await client.query(
    `WITH RECURSIVE chain AS (
       SELECT p.id, p.parent_id, p.user_id, p.content, p.is_hidden, p.is_comment, p.depth,
              p.community_group_id, p.created_at, 0 AS level
       FROM posts p WHERE p.id = $1
       UNION ALL
       SELECT p.id, p.parent_id, p.user_id, p.content, p.is_hidden, p.is_comment, p.depth,
              p.community_group_id, p.created_at, c.level + 1
       FROM posts p JOIN chain c ON p.id = c.parent_id WHERE c.level < $3
     )
     SELECT c.id, c.parent_id, c.user_id, c.content, c.is_comment, c.depth, c.community_group_id, c.level,
            u.username, (u.deleted_at IS NULL AND ${buildPostVisibilityClauseForAlias('c', '$2')}) AS visible
     FROM chain c JOIN users u ON u.id = c.user_id
     ORDER BY c.level ASC`,
    [postId, viewerId, 128]
  );
  const rows = result.rows;
  // Validate the whole ancestry, including roots beyond the prompt limit.
  // A hidden/group root must never become public context through a deep reply.
  if (!rows.length || rows.some((row) => !row.visible) || rows[rows.length - 1].parent_id) return null;
  if (rows.some((row) => row.community_group_id)) throw new JobFailure('group_unsupported');
  return { trigger: rows[0], thread: rows.slice(0, PROMPT_LIMITS.threadAncestors + 1).reverse() };
};

const withTransaction = async (callback) => {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep original */ }
    throw error;
  } finally {
    client.release();
  }
};

class JobFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

const createPublicReplyWorker = ({ io, complete = providers.complete, concurrency = 2, intervalMs = 3000 } = {}) => {
  const limit = Math.max(1, Math.min(8, Math.trunc(concurrency) || 2));
  let running = null;
  let timer;

  const emitStatus = (job, status, extra = {}) => {
    // Targeted to the requester only; never a global broadcast.
    io?.to?.(`user:${job.requester_user_id}`)?.emit?.('ai_public_reply_status', {
      post_id: job.post_id,
      status,
      reason: status === 'failed' ? describeFailure(extra.errorCode) : null,
      reply_post_id: extra.replyPostId || null
    });
  };

  const markFailed = async (job, code) => {
    await db.query(
      `UPDATE ai_public_reply_jobs SET status = 'failed', error_code = $3, lease_id = NULL,
         locked_until = NULL, updated_at = NOW()
       WHERE post_id = $1 AND lease_id = $2 AND status = 'running'`,
      [job.post_id, job.lease_id, code]
    );
    emitStatus(job, 'failed', { errorCode: code });
  };

  const prepare = (job) => withTransaction(async (client) => {
    const bot = await getBotIdentity(client);
    if (!bot) throw new JobFailure('bot_missing');
    let credentials;
    try {
      credentials = await loadCredentials(job.requester_user_id, client);
    } catch (error) {
      throw new JobFailure(error instanceof AiProviderError ? error.code : 'unavailable');
    }
    if (!credentials) throw new JobFailure('not_configured');
    if (!credentials.publicReplies) throw new JobFailure('public_replies_disabled');
    if (!providers.isValidModel(credentials.model)) throw new JobFailure('invalid_model');
    const loaded = await loadThread(client, job.post_id, job.requester_user_id);
    if (!loaded) throw new JobFailure('post_unavailable');
    if (!mentionsAi(loaded.trigger.content)) throw new JobFailure('post_unavailable');
    if (loaded.thread.some((row) => row.community_group_id)) throw new JobFailure('group_unsupported');
    if (loaded.trigger.user_id !== job.requester_user_id) throw new JobFailure('post_unavailable');
    const requester = loaded.thread[loaded.thread.length - 1];
    try {
      await reserve(client, job.requester_user_id, 'public', { selfIncluded: true });
    } catch (error) {
      throw new JobFailure(error instanceof AiBudgetError ? error.code : 'internal');
    }
    return { bot, credentials, thread: loaded.thread, trigger: loaded.trigger, requesterUsername: requester.username };
  });

  const publish = (job, prepared, completion) => withTransaction(async (client) => {
    const post = (await client.query(
      'SELECT id, user_id, is_hidden, is_comment, depth FROM posts WHERE id = $1 FOR UPDATE',
      [job.post_id]
    )).rows[0];
    if (!post || post.is_hidden) throw new JobFailure('post_unavailable');
    if (!await loadThread(client, job.post_id, job.requester_user_id)) throw new JobFailure('post_unavailable');
    const lease = await client.query(
      `SELECT post_id FROM ai_public_reply_jobs WHERE post_id = $1 AND lease_id = $2 AND status = 'running' FOR UPDATE`,
      [job.post_id, job.lease_id]
    );
    if (!lease.rows.length) throw new JobFailure('interrupted');
    const content = formatPublicReply({ text: completion.text, model: completion.model, requesterUsername: prepared.requesterUsername });
    const reply = (await client.query(
      `INSERT INTO posts (user_id, content, parent_id, depth, is_comment, is_bot, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, TRUE, NOW(), NOW()) RETURNING *`,
      [prepared.bot.id, content, post.id, (post.depth || 0) + 1]
    )).rows[0];
    await client.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [post.id]);
    await client.query(
      `UPDATE ai_public_reply_jobs SET status = 'published', reply_post_id = $3, model = $4,
         lease_id = NULL, locked_until = NULL, updated_at = NOW()
       WHERE post_id = $1 AND lease_id = $2`,
      [job.post_id, job.lease_id, reply.id, completion.model]
    );
    return { reply: { ...reply, username: prepared.bot.username }, parent: post };
  });

  const processJob = async (job) => {
    let prepared;
    let completion;
    try {
      prepared = await prepare(job);
    } catch (error) {
      if (error instanceof JobFailure) return markFailed(job, error.code);
      throw error;
    }
    try {
      completion = await complete({
        provider: prepared.credentials.provider,
        model: prepared.credentials.model,
        apiKey: prepared.credentials.apiKey,
        system: buildPublicSystemPrompt({ requesterUsername: prepared.requesterUsername }),
        messages: buildPublicTurns(prepared.thread)
      });
    } catch (error) {
      // Any provider failure (including ambiguous timeouts) ends the job; the
      // user can summon @ai again, which is a new paid request they chose.
      return markFailed(job, error instanceof AiProviderError ? error.code : 'internal');
    }
    let published;
    try {
      published = await publish(job, prepared, completion);
    } catch (error) {
      if (error instanceof JobFailure) return markFailed(job, error.code);
      throw error;
    }
    const { reply, parent } = published;
    try {
      if (parent.is_comment) {
        await notificationService.createReplyNotification(prepared.bot.id, parent.id, parent.user_id, reply.id);
      } else {
        await notificationService.createCommentNotification(prepared.bot.id, parent.id, parent.user_id, reply.id);
      }
    } catch (error) {
      console.error('[AI] public reply notification failed:', error?.message || error);
    }
    io?.to?.(`post:${parent.id}`)?.emit?.('new_comment', reply);
    emitStatus(job, 'published', { replyPostId: reply.id });
  };

  const runOnce = () => {
    if (running) return running;
    running = (async () => {
      // Leases that expired belong to a crashed or hung worker. The provider
      // may or may not have been charged, so the job is failed, never re-run.
      const expired = await db.query(
        `UPDATE ai_public_reply_jobs SET status = 'failed', error_code = 'interrupted', lease_id = NULL,
           locked_until = NULL, updated_at = NOW()
         WHERE status = 'running' AND locked_until < NOW() RETURNING post_id, requester_user_id`
      );
      expired.rows.forEach((job) => emitStatus(job, 'failed', { errorCode: 'interrupted' }));

      const claimed = await db.query(
        `WITH ready AS (
           SELECT post_id FROM ai_public_reply_jobs WHERE status = 'queued'
           ORDER BY created_at, post_id FOR UPDATE SKIP LOCKED LIMIT $1
         ) UPDATE ai_public_reply_jobs j SET status = 'running', lease_id = $2,
             locked_until = NOW() + ($3 * INTERVAL '1 second'), attempts = j.attempts + 1, updated_at = NOW()
           FROM ready WHERE j.post_id = ready.post_id RETURNING j.*`,
        [limit, randomUUID(), LEASE_SECONDS]
      );
      const results = await Promise.allSettled(claimed.rows.map(processJob));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    })().finally(() => { running = null; });
    return running;
  };
  const start = () => {
    if (timer) return;
    const tick = () => runOnce().catch((error) => console.error('[AI] public reply worker failed:', error?.message || error));
    timer = setInterval(tick, intervalMs);
    timer.unref();
    tick();
  };
  const stop = () => { clearInterval(timer); timer = null; };
  return { start, stop, runOnce };
};

const resetBotCache = () => { botCache = null; };

module.exports = { enqueueForPost, getStatus, describeFailure, getBotIdentity, resetBotCache, createPublicReplyWorker, NOTICES };
