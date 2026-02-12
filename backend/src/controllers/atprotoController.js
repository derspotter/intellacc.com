const { Agent } = require('@atproto/api');
const db = require('../db');
const atprotoAccount = require('../services/atproto/accountService');
const atprotoOutbound = require('../services/atproto/outboundService');
const {
  getOAuthClient,
  getClientMetadata,
  getFederationRedirectUri
} = require('../services/atproto/oauthClientService');

const errorStatus = (err) => {
  if (err?.statusCode) {
    if (err.statusCode === 400 || err.statusCode === 401 || err.statusCode === 403) return 400;
    if (err.statusCode >= 500) return 502;
  }

  const msg = String(err?.message || '').toLowerCase();
  if (
    msg.includes('missing')
    || msg.includes('invalid')
    || msg.includes('unsupported')
    || msg.includes('oauth')
  ) {
    return 400;
  }
  return 500;
};

const parseUserState = (value) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    const userId = Number(parsed?.userId);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    return {
      userId,
      handle: String(parsed?.handle || '').trim() || null,
      pdsUrl: String(parsed?.pdsUrl || '').trim() || null
    };
  } catch {
    return null;
  }
};

const callbackSearchParams = (req) => {
  const raw = String(req.originalUrl || '');
  const idx = raw.indexOf('?');
  if (idx === -1) return new URLSearchParams();
  return new URLSearchParams(raw.slice(idx + 1));
};

exports.getClientMetadata = async (req, res) => {
  try {
    return res.status(200).json(getClientMetadata());
  } catch (err) {
    console.error('[ATProto] Failed to build OAuth client metadata:', err?.message || err);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.startOAuth = async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || req.body?.handle || '').trim();
    const pdsUrl = String(req.body?.pdsUrl || '').trim() || null;

    if (!identifier) {
      return res.status(400).json({
        error: 'identifier is required'
      });
    }

    const state = JSON.stringify({
      userId: req.user.id,
      handle: identifier,
      pdsUrl
    });

    const authorizationUrl = await getOAuthClient().authorize(identifier, {
      state,
      redirect_uri: getFederationRedirectUri()
    });

    return res.status(200).json({
      authorizationUrl: String(authorizationUrl)
    });
  } catch (err) {
    const status = errorStatus(err);
    console.error('[ATProto] OAuth start failed:', err?.message || err);
    return res.status(status).json({
      error: status === 500 ? 'Server error' : String(err?.message || 'OAuth start failed')
    });
  }
};

exports.oauthCallback = async (req, res) => {
  try {
    const params = callbackSearchParams(req);
    const { session, state } = await getOAuthClient().callback(params, {
      redirect_uri: getFederationRedirectUri()
    });

    const parsedState = parseUserState(state);
    if (!parsedState?.userId) {
      return res.status(400).json({ error: 'Invalid OAuth state' });
    }

    let handle = parsedState.handle || session.did;
    let pdsUrl = parsedState.pdsUrl || session?.serverMetadata?.issuer || 'https://bsky.social';

    try {
      const agent = new Agent(session);
      const profile = await agent.getProfile({ actor: session.did });
      if (profile?.data?.handle) {
        handle = profile.data.handle;
      }
    } catch (profileErr) {
      console.warn('[ATProto] Profile lookup during OAuth callback failed:', profileErr?.message || profileErr);
    }

    const account = await atprotoAccount.upsertLinkedAccount({
      userId: parsedState.userId,
      did: session.did,
      handle,
      pdsUrl
    });

    return res.status(200).json({
      ok: true,
      account
    });
  } catch (err) {
    const status = errorStatus(err);
    console.error('[ATProto] OAuth callback failed:', err?.message || err);
    return res.status(status).json({
      error: status === 500 ? 'Server error' : String(err?.message || 'OAuth callback failed')
    });
  }
};

exports.getAccount = async (req, res) => {
  try {
    const account = await atprotoAccount.getConnectedAccount(req.user.id);
    return res.status(200).json({ account });
  } catch (err) {
    console.error('[ATProto] Account lookup failed:', err?.message || err);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.disconnectAccount = async (req, res) => {
  try {
    await atprotoAccount.disconnectAccount(req.user.id);
    return res.status(204).send();
  } catch (err) {
    console.error('[ATProto] Disconnect failed:', err?.message || err);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.enqueuePost = async (req, res) => {
  try {
    const postId = Number(req.params.postId);
    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ error: 'Invalid postId' });
    }

    const postRes = await db.query(
      `SELECT id, user_id, parent_id, is_comment
       FROM posts
       WHERE id = $1`,
      [postId]
    );
    const post = postRes.rows[0];
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.user_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
    if (post.parent_id || post.is_comment) return res.status(400).json({ error: 'Only top-level posts can be federated' });

    const queued = await atprotoOutbound.enqueueCreateForLocalPost({ post });
    return res.status(202).json(queued);
  } catch (err) {
    console.error('[ATProto] Enqueue post failed:', err?.message || err);
    return res.status(500).json({ error: 'Server error' });
  }
};
