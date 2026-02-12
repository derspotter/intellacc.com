const db = require('../../db');
const {
  getRequestBaseUrl,
  actorKeyIdForUsername,
  postObjectId,
  postCreateActivityId,
  followActivityIdForActor
} = require('./url');
const { buildCreateActivity, buildFollowActivity } = require('./renderService');
const { fetchRemoteActor } = require('./remoteActorService');
const { enqueueDelivery } = require('./deliveryQueueService');

const upsertObjectMap = async ({ postId, objectUri, activityUri }) => {
  await db.query(
    `INSERT INTO ap_object_map (post_id, object_uri, activity_uri)
     VALUES ($1, $2, $3)
     ON CONFLICT (post_id) DO UPDATE
       SET object_uri = EXCLUDED.object_uri,
           activity_uri = EXCLUDED.activity_uri`,
    [postId, objectUri, activityUri]
  );
};

const enqueueCreateForLocalPost = async ({ req, baseUrl: baseUrlOverride, post, username }) => {
  if (!post || !post.id) return { enqueued: 0 };
  if (post.parent_id || post.is_comment) return { enqueued: 0 };

  const baseUrl = baseUrlOverride || getRequestBaseUrl(req);
  const signingKeyId = actorKeyIdForUsername(baseUrl, username);

  const objectUri = postObjectId(baseUrl, post.id);
  const activityUri = postCreateActivityId(baseUrl, username, post.id);
  await upsertObjectMap({ postId: post.id, objectUri, activityUri });

  const payload = buildCreateActivity({ baseUrl, post, username });

  // Enqueue one delivery per *unique* inbox URL (use sharedInbox when available).
  // Use a single INSERT ... SELECT to avoid N inserts for N followers.
  const inserted = await db.query(
    `INSERT INTO federation_delivery_queue (protocol, target_url, signing_key_id, payload)
     SELECT 'ap', t.target_url, $2, $3
     FROM (
       SELECT DISTINCT COALESCE(r.shared_inbox_url, r.inbox_url) AS target_url
       FROM ap_followers f
       JOIN ap_remote_actors r ON r.actor_uri = f.actor_uri
       WHERE f.user_id = $1
         AND f.state = 'accepted'
         AND r.inbox_url IS NOT NULL
     ) t`,
    [post.user_id, signingKeyId, payload]
  );

  return { enqueued: inserted.rowCount || 0 };
};

const enqueueFollowForLocalUser = async ({ req, baseUrl: baseUrlOverride, userId, username, remoteActorUri }) => {
  if (!userId) throw new Error('Missing userId');
  if (!username) throw new Error('Missing username');
  if (!remoteActorUri) throw new Error('Missing remoteActorUri');

  const baseUrl = baseUrlOverride || getRequestBaseUrl(req);
  const remoteActor = await fetchRemoteActor(remoteActorUri);
  const followActivityId = followActivityIdForActor(baseUrl, username, remoteActor.actorUri);

  const existing = await db.query(
    `SELECT state
     FROM ap_following
     WHERE follower_user_id = $1 AND actor_uri = $2`,
    [userId, remoteActor.actorUri]
  );

  if (existing.rows[0]?.state === 'accepted') {
    return {
      enqueued: false,
      state: 'accepted',
      actorUri: remoteActor.actorUri,
      followActivityId
    };
  }

  await db.query(
    `INSERT INTO ap_following (follower_user_id, actor_uri, follow_activity_uri, state, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', NOW(), NOW())
     ON CONFLICT (follower_user_id, actor_uri) DO UPDATE
       SET follow_activity_uri = EXCLUDED.follow_activity_uri,
           state = 'pending',
           updated_at = NOW()`,
    [userId, remoteActor.actorUri, followActivityId]
  );

  const signingKeyId = actorKeyIdForUsername(baseUrl, username);
  const payload = buildFollowActivity({
    baseUrl,
    localUsername: username,
    remoteActorUri: remoteActor.actorUri,
    followActivityId
  });

  const targetUrl = remoteActor.sharedInboxUrl || remoteActor.inboxUrl;
  const deliveryId = await enqueueDelivery({
    targetUrl,
    signingKeyId,
    payload
  });

  return {
    enqueued: true,
    deliveryId,
    state: 'pending',
    actorUri: remoteActor.actorUri,
    followActivityId
  };
};

module.exports = {
  enqueueCreateForLocalPost,
  enqueueFollowForLocalUser
};
