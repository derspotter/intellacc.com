const { AS_CONTEXT, SECURITY_CONTEXT, PUBLIC_AUDIENCE } = require('./constants');
const {
  actorIdForUsername,
  actorKeyIdForUsername,
  inboxUrlForUsername,
  outboxUrlForUsername,
  followersUrlForUsername,
  postObjectId,
  postCreateActivityId,
  followActivityIdForActor
} = require('./url');

const escapeHtml = (input) => String(input || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&#39;');

const renderNoteContent = (text) => `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;

const buildWebfinger = ({ subjectAcct, actorHref }) => {
  return {
    subject: subjectAcct,
    links: [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: actorHref
      }
    ]
  };
};

const buildActor = ({ baseUrl, user, publicKeyPem }) => {
  const username = user.username;
  const actorId = actorIdForUsername(baseUrl, username);
  const keyId = actorKeyIdForUsername(baseUrl, username);

  return {
    '@context': [AS_CONTEXT, SECURITY_CONTEXT],
    id: actorId,
    type: 'Person',
    preferredUsername: username,
    name: username,
    summary: user.bio || '',
    inbox: inboxUrlForUsername(baseUrl, username),
    outbox: outboxUrlForUsername(baseUrl, username),
    followers: followersUrlForUsername(baseUrl, username),
    publicKey: {
      id: keyId,
      owner: actorId,
      publicKeyPem
    }
  };
};

const buildNote = ({ baseUrl, post, username }) => {
  const actorId = actorIdForUsername(baseUrl, username);
  const noteId = postObjectId(baseUrl, post.id);
  const followers = followersUrlForUsername(baseUrl, username);

  const note = {
    id: noteId,
    type: 'Note',
    attributedTo: actorId,
    content: renderNoteContent(post.content),
    published: new Date(post.created_at).toISOString(),
    to: [PUBLIC_AUDIENCE],
    cc: [followers]
  };

  // Only include external images for MVP; internal attachments are auth-gated.
  if (post.image_url && /^https?:\/\//i.test(String(post.image_url))) {
    note.attachment = [
      {
        type: 'Image',
        url: post.image_url
      }
    ];
  }

  return note;
};

const buildCreateActivity = ({ baseUrl, post, username }) => {
  const actorId = actorIdForUsername(baseUrl, username);
  const followers = followersUrlForUsername(baseUrl, username);

  return {
    '@context': AS_CONTEXT,
    id: postCreateActivityId(baseUrl, username, post.id),
    type: 'Create',
    actor: actorId,
    published: new Date(post.created_at).toISOString(),
    to: [PUBLIC_AUDIENCE],
    cc: [followers],
    object: buildNote({ baseUrl, post, username })
  };
};

const buildAcceptActivity = ({ baseUrl, localUsername, followActivity }) => {
  const actorId = actorIdForUsername(baseUrl, localUsername);
  const acceptId = `${actorId}/accepts/${encodeURIComponent(String(followActivity.id || cryptoRandomId()))}`;

  return {
    '@context': AS_CONTEXT,
    id: acceptId,
    type: 'Accept',
    actor: actorId,
    to: [typeof followActivity.actor === 'string' ? followActivity.actor : followActivity.actor?.id].filter(Boolean),
    object: followActivity
  };
};

const buildFollowActivity = ({ baseUrl, localUsername, remoteActorUri, followActivityId }) => {
  const actorId = actorIdForUsername(baseUrl, localUsername);
  return {
    '@context': AS_CONTEXT,
    id: followActivityId || followActivityIdForActor(baseUrl, localUsername, remoteActorUri),
    type: 'Follow',
    actor: actorId,
    to: [remoteActorUri],
    object: remoteActorUri
  };
};

const cryptoRandomId = () => {
  // Lightweight random ID for activity IDs when remote IDs are missing.
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
};

module.exports = {
  buildWebfinger,
  buildActor,
  buildNote,
  buildCreateActivity,
  buildAcceptActivity,
  buildFollowActivity
};
