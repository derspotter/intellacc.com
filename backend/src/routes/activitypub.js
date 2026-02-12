const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const db = require('../db');

const { ACTIVITY_JSON, JRD_JSON } = require('../services/activitypub/constants');
const { ensureServerKey } = require('../services/activitypub/keyService');
const { verifyHttpSignature } = require('../services/activitypub/signatureService');
const { getRequestBaseUrl, actorIdForUsername, actorKeyIdForUsername } = require('../services/activitypub/url');
const { buildWebfinger, buildActor, buildCreateActivity, buildNote, buildAcceptActivity } = require('../services/activitypub/renderService');
const { enqueueDelivery } = require('../services/activitypub/deliveryQueueService');

const router = express.Router();

const inboxRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

const sha256Base64 = (buf) => crypto.createHash('sha256').update(buf || Buffer.alloc(0)).digest('base64');
const normalizeUri = (value) => String(value || '').split('#')[0];
const getIdValue = (value) => (typeof value === 'string' ? value : value?.id);

const getUserByUsername = async (username) => {
  const result = await db.query(
    'SELECT id, username, bio FROM users WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL',
    [username]
  );
  return result.rows[0] || null;
};

router.get('/.well-known/webfinger', async (req, res) => {
  try {
    const resource = String(req.query.resource || '');
    const match = resource.match(/^acct:([^@]+)@(.+)$/i);
    if (!match) {
      return res.status(400).json({ error: 'Invalid resource' });
    }

    const username = match[1];
    const domain = match[2].toLowerCase();
    const requestHostname = String(req.hostname || '').toLowerCase();

    // Only serve WebFinger for our own domain/host.
    if (!requestHostname || domain !== requestHostname) {
      return res.status(404).json({ error: 'Not found' });
    }

    const user = await getUserByUsername(username);
    if (!user) {
      return res.status(404).json({ error: 'Not found' });
    }

    const baseUrl = getRequestBaseUrl(req);
    const actorHref = actorIdForUsername(baseUrl, user.username);
    const subjectAcct = `acct:${user.username}@${domain}`;

    res.type(JRD_JSON).json(buildWebfinger({ subjectAcct, actorHref }));
  } catch (err) {
    console.error('[ActivityPub] WebFinger error:', err?.message || err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/ap/users/:username', async (req, res) => {
  try {
    const user = await getUserByUsername(req.params.username);
    if (!user) {
      return res.status(404).json({ error: 'Not found' });
    }

    const baseUrl = getRequestBaseUrl(req);
    const { publicKeyPem } = await ensureServerKey();

    res.type(ACTIVITY_JSON).json(buildActor({ baseUrl, user, publicKeyPem }));
  } catch (err) {
    console.error('[ActivityPub] Actor error:', err?.message || err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/ap/users/:username/followers', async (req, res) => {
  try {
    const user = await getUserByUsername(req.params.username);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const baseUrl = getRequestBaseUrl(req);
    const collectionId = `${actorIdForUsername(baseUrl, user.username)}/followers`;

    const countRes = await db.query(
      'SELECT COUNT(*)::int AS count FROM ap_followers WHERE user_id = $1 AND state = \'accepted\'',
      [user.id]
    );
    const totalItems = countRes.rows[0]?.count || 0;

    if (!('page' in req.query)) {
      return res.type(ACTIVITY_JSON).json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionId,
        type: 'OrderedCollection',
        totalItems,
        first: `${collectionId}?page=true`
      });
    }

    const followersRes = await db.query(
      `SELECT actor_uri
       FROM ap_followers
       WHERE user_id = $1 AND state = 'accepted'
       ORDER BY created_at DESC
       LIMIT 50`,
      [user.id]
    );

    res.type(ACTIVITY_JSON).json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${collectionId}?page=true`,
      type: 'OrderedCollectionPage',
      partOf: collectionId,
      totalItems,
      orderedItems: followersRes.rows.map((r) => r.actor_uri)
    });
  } catch (err) {
    console.error('[ActivityPub] Followers error:', err?.message || err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/ap/users/:username/outbox', async (req, res) => {
  try {
    const user = await getUserByUsername(req.params.username);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const baseUrl = getRequestBaseUrl(req);
    const collectionId = `${actorIdForUsername(baseUrl, user.username)}/outbox`;

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM posts
       WHERE user_id = $1 AND parent_id IS NULL AND is_comment = FALSE`,
      [user.id]
    );
    const totalItems = countRes.rows[0]?.count || 0;

    if (!('page' in req.query)) {
      return res.type(ACTIVITY_JSON).json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionId,
        type: 'OrderedCollection',
        totalItems,
        first: `${collectionId}?page=true`
      });
    }

    const postsRes = await db.query(
      `SELECT id, user_id, content, image_url, created_at
       FROM posts
       WHERE user_id = $1 AND parent_id IS NULL AND is_comment = FALSE
       ORDER BY created_at DESC, id DESC
       LIMIT 20`,
      [user.id]
    );

    const orderedItems = postsRes.rows.map((post) => buildCreateActivity({ baseUrl, post, username: user.username }));

    res.type(ACTIVITY_JSON).json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${collectionId}?page=true`,
      type: 'OrderedCollectionPage',
      partOf: collectionId,
      totalItems,
      orderedItems
    });
  } catch (err) {
    console.error('[ActivityPub] Outbox error:', err?.message || err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/ap/objects/posts/:id', async (req, res) => {
  try {
    const postId = Number(req.params.id);
    if (!Number.isInteger(postId)) return res.status(400).json({ error: 'Invalid id' });

    const postRes = await db.query(
      `SELECT p.id, p.user_id, p.content, p.image_url, p.created_at, u.username
       FROM posts p
       JOIN users u ON u.id = p.user_id
       WHERE p.id = $1`,
      [postId]
    );
    if (postRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const baseUrl = getRequestBaseUrl(req);
    const row = postRes.rows[0];
    const note = buildNote({ baseUrl, post: row, username: row.username });

    res.type(ACTIVITY_JSON).json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      ...note
    });
  } catch (err) {
    console.error('[ActivityPub] Object error:', err?.message || err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/ap/users/:username/inbox', inboxRateLimit, async (req, res) => {
  let localUser;
  try {
    localUser = await getUserByUsername(req.params.username);
    if (!localUser) return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[ActivityPub] Inbox user lookup failed:', err?.message || err);
    return res.status(500).json({ error: 'Server error' });
  }

  try {
    const { remoteActor } = await verifyHttpSignature(req);
    const activity = req.body;
    if (!activity || typeof activity !== 'object') {
      return res.status(400).json({ error: 'Invalid activity' });
    }

    const activityId = activity.id || `sha256:${sha256Base64(req.rawBody)}`;

    const dedupe = await db.query(
      `INSERT INTO federation_inbox_dedupe (protocol, remote_id)
       VALUES ('ap', $1)
       ON CONFLICT (protocol, remote_id) DO NOTHING
       RETURNING remote_id`,
      [activityId]
    );
    if (dedupe.rows.length === 0) {
      return res.status(200).json({ status: 'ok' });
    }

    const activityType = String(activity.type || '').toLowerCase();
    const actorUri = getIdValue(activity.actor);
    if (!actorUri || normalizeUri(actorUri) !== remoteActor.actorUri) {
      return res.status(401).json({ error: 'Actor mismatch' });
    }

    const baseUrl = getRequestBaseUrl(req);
    const localActorId = actorIdForUsername(baseUrl, localUser.username);

    if (activityType === 'follow') {
      const objectId = getIdValue(activity.object);
      if (objectId !== localActorId) {
        return res.status(400).json({ error: 'Follow object mismatch' });
      }

      await db.query(
        `INSERT INTO ap_followers (user_id, actor_uri, state)
         VALUES ($1, $2, 'accepted')
         ON CONFLICT (user_id, actor_uri) DO UPDATE
           SET state = 'accepted'`,
        [localUser.id, remoteActor.actorUri]
      );

      const accept = buildAcceptActivity({
        baseUrl,
        localUsername: localUser.username,
        followActivity: { ...activity, id: activityId }
      });

      const signingKeyId = actorKeyIdForUsername(baseUrl, localUser.username);
      await enqueueDelivery({
        targetUrl: remoteActor.inboxUrl,
        signingKeyId,
        payload: accept
      });

      return res.status(202).json({ status: 'accepted' });
    }

    if (activityType === 'accept' || activityType === 'reject') {
      const object = activity.object;
      const objectId = getIdValue(object);
      const objectActor = normalizeUri(getIdValue(object?.actor)) || null;
      const objectTarget = normalizeUri(getIdValue(object?.object)) || null;

      const result = await db.query(
        `UPDATE ap_following
         SET state = $3,
             updated_at = NOW()
         WHERE follower_user_id = $1
           AND actor_uri = $2
           AND (
             follow_activity_uri = $4
             OR (
               $4 IS NULL
               AND ($5 = $6 OR $5 IS NULL)
               AND ($7 = $2 OR $7 IS NULL)
             )
           )
         RETURNING id`,
        [
          localUser.id,
          remoteActor.actorUri,
          activityType === 'accept' ? 'accepted' : 'rejected',
          objectId || null,
          objectActor || null,
          localActorId,
          objectTarget || null
        ]
      );

      if (result.rows.length === 0) {
        return res.status(202).json({ status: 'ignored' });
      }
      return res.status(202).json({ status: activityType === 'accept' ? 'accepted' : 'rejected' });
    }

    if (activityType === 'undo') {
      const undoObject = activity.object;
      const undoType = String(undoObject?.type || '').toLowerCase();
      const undoActor = normalizeUri(getIdValue(undoObject?.actor)) || null;
      const undoTarget = normalizeUri(getIdValue(undoObject?.object)) || null;

      if (undoType === 'follow' && undoActor === remoteActor.actorUri && undoTarget === localActorId) {
        await db.query(
          `DELETE FROM ap_followers
           WHERE user_id = $1 AND actor_uri = $2`,
          [localUser.id, remoteActor.actorUri]
        );
        return res.status(202).json({ status: 'undone' });
      }

      return res.status(202).json({ status: 'ignored' });
    }

    return res.status(202).json({ status: 'ignored' });
  } catch (err) {
    const status = err?.statusCode || 500;
    console.error('[ActivityPub] Inbox error:', err?.message || err);
    res.status(status).json({ error: status === 401 ? 'Unauthorized' : 'Server error' });
  }
});

module.exports = router;
