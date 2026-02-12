const crypto = require('crypto');

const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const getRequestBaseUrl = (req) => {
  const configured = stripTrailingSlash(process.env.FEDERATION_BASE_URL);
  if (configured) return configured;

  const protocol = req.protocol || 'http';
  const host = req.get('host');
  return stripTrailingSlash(`${protocol}://${host}`);
};

const actorIdForUsername = (baseUrl, username) => `${stripTrailingSlash(baseUrl)}/ap/users/${encodeURIComponent(username)}`;
const actorKeyIdForUsername = (baseUrl, username) => `${actorIdForUsername(baseUrl, username)}#main-key`;

const inboxUrlForUsername = (baseUrl, username) => `${actorIdForUsername(baseUrl, username)}/inbox`;
const outboxUrlForUsername = (baseUrl, username) => `${actorIdForUsername(baseUrl, username)}/outbox`;
const followersUrlForUsername = (baseUrl, username) => `${actorIdForUsername(baseUrl, username)}/followers`;

const postObjectId = (baseUrl, postId) => `${stripTrailingSlash(baseUrl)}/ap/objects/posts/${encodeURIComponent(String(postId))}`;
const postCreateActivityId = (baseUrl, username, postId) =>
  `${stripTrailingSlash(baseUrl)}/ap/users/${encodeURIComponent(username)}/activities/create-post-${encodeURIComponent(String(postId))}`;
const followActivityIdForActor = (baseUrl, username, remoteActorUri) => {
  const digest = crypto.createHash('sha256').update(String(remoteActorUri || '')).digest('hex').slice(0, 24);
  return `${stripTrailingSlash(baseUrl)}/ap/users/${encodeURIComponent(username)}/activities/follow-${digest}`;
};

module.exports = {
  getRequestBaseUrl,
  actorIdForUsername,
  actorKeyIdForUsername,
  inboxUrlForUsername,
  outboxUrlForUsername,
  followersUrlForUsername,
  postObjectId,
  postCreateActivityId,
  followActivityIdForActor
};
