const db = require('../db');
const activitypubOutbound = require('../services/activitypub/outboundService');
const { resolveActorUri } = require('../services/activitypub/remoteActorService');
const { getRequestBaseUrl, actorIdForUsername } = require('../services/activitypub/url');

const parseTargetIdentifier = (body) => {
  if (!body || typeof body !== 'object') return '';

  const candidates = [
    body.actor,
    body.actorUri,
    body.handle,
    body.account,
    body.resource
  ];

  for (const raw of candidates) {
    const value = String(raw || '').trim();
    if (value) return value;
  }

  return '';
};

const getUserIdentity = async (userId) => {
  const userRes = await db.query(
    `SELECT id, username
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return userRes.rows[0] || null;
};

const inferErrorStatus = (err) => {
  const msg = String(err?.message || '').toLowerCase();
  if (!msg) return 500;
  if (msg.includes('missing') || msg.includes('invalid') || msg.includes('unsupported')) return 400;
  if (msg.includes('ssrf blocked')) return 400;
  if (msg.includes('failed to fetch')) return 502;
  if (msg.includes('actor did not include')) return 502;
  if (msg.includes('webfinger')) return 502;
  return 500;
};

exports.followActivityPubActor = async (req, res) => {
  try {
    const identifier = parseTargetIdentifier(req.body);
    if (!identifier) {
      return res.status(400).json({
        error: 'Provide a remote actor URL or account handle'
      });
    }

    const localUser = await getUserIdentity(req.user.id);
    if (!localUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const baseUrl = getRequestBaseUrl(req);
    const localActorId = actorIdForUsername(baseUrl, localUser.username);

    const remoteActorUri = await resolveActorUri(identifier);
    if (remoteActorUri === localActorId) {
      return res.status(400).json({ error: 'Cannot follow your own actor' });
    }

    const result = await activitypubOutbound.enqueueFollowForLocalUser({
      baseUrl,
      userId: localUser.id,
      username: localUser.username,
      remoteActorUri
    });

    const statusCode = result.state === 'accepted' ? 200 : 202;
    return res.status(statusCode).json({
      status: result.state,
      actorUri: result.actorUri,
      followActivityId: result.followActivityId,
      deliveryId: result.deliveryId || null,
      enqueued: Boolean(result.enqueued)
    });
  } catch (err) {
    const statusCode = inferErrorStatus(err);
    console.error('[ActivityPub] Outbound follow error:', err?.message || err);
    return res.status(statusCode).json({
      error: statusCode === 500 ? 'Server error' : String(err?.message || 'Request failed')
    });
  }
};

exports.getActivityPubFollowing = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT f.actor_uri, f.state, f.follow_activity_uri, f.created_at, f.updated_at,
              r.inbox_url, r.shared_inbox_url, r.last_seen
       FROM ap_following f
       LEFT JOIN ap_remote_actors r ON r.actor_uri = f.actor_uri
       WHERE f.follower_user_id = $1
       ORDER BY f.updated_at DESC
       LIMIT 200`,
      [req.user.id]
    );

    return res.status(200).json({
      items: result.rows.map((row) => ({
        actorUri: row.actor_uri,
        state: row.state,
        followActivityId: row.follow_activity_uri,
        inboxUrl: row.inbox_url,
        sharedInboxUrl: row.shared_inbox_url,
        lastSeen: row.last_seen,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
  } catch (err) {
    console.error('[ActivityPub] Failed to list following:', err?.message || err);
    return res.status(500).json({ error: 'Server error' });
  }
};
