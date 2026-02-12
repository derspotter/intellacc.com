const { Agent } = require('@atproto/api');
const db = require('../../db');
const { getLinkedAccountByUserId, noAccountError } = require('./accountService');
const { restoreOAuthSessionByDid } = require('./oauthClientService');
const { buildPostRecord } = require('./recordService');

const parseRkeyFromUri = (uri) => {
  const parts = String(uri || '').split('/');
  return parts[parts.length - 1] || null;
};

const upsertPostMap = async ({ postId, userId, uri, cid }) => {
  await db.query(
    `INSERT INTO atproto_post_map (post_id, user_id, at_uri, at_cid, record_rkey, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (post_id) DO UPDATE
       SET at_uri = EXCLUDED.at_uri,
           at_cid = EXCLUDED.at_cid,
           record_rkey = EXCLUDED.record_rkey,
           updated_at = NOW()`,
    [postId, userId, uri, cid || null, parseRkeyFromUri(uri)]
  );
};

const restoreOAuthSessionOrThrow = async (did) => {
  try {
    return await restoreOAuthSessionByDid(did, 'auto');
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('revoked') || msg.includes('invalid') || msg.includes('expired') || msg.includes('refresh')) {
      const terminal = noAccountError();
      terminal.message = 'ATProto OAuth session is no longer valid';
      terminal.cause = err;
      throw terminal;
    }
    throw err;
  }
};

const publishPost = async ({ userId, post }) => {
  if (!post || !post.id) throw new Error('Missing post');
  if (post.parent_id || post.is_comment) return { skipped: true, reason: 'comment' };

  const account = await getLinkedAccountByUserId(userId);
  if (!account || account.isEnabled === false) {
    throw noAccountError();
  }

  const oauthSession = await restoreOAuthSessionOrThrow(account.did);
  const agent = new Agent(oauthSession);

  const record = await agent.post(
    buildPostRecord({
      text: post.content,
      createdAt: post.created_at
    })
  );

  await upsertPostMap({
    postId: post.id,
    userId,
    uri: record.uri,
    cid: record.cid
  });

  return {
    skipped: false,
    uri: record.uri,
    cid: record.cid
  };
};

module.exports = {
  publishPost
};
