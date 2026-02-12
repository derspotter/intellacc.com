const db = require('../../db');
const { ACTIVITY_JSON } = require('./constants');
const { assertSsrfSafeUrl } = require('./ssrf');
const { fetchJson } = require('./fetch');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const stripFragment = (uri) => String(uri || '').split('#')[0];
const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

const getAllowPrivateNetworks = () => {
  if (process.env.FEDERATION_ALLOW_PRIVATE_NETWORKS === 'true') return true;
  return process.env.NODE_ENV === 'test';
};

const getAllowHosts = () => {
  const raw = String(process.env.FEDERATION_ALLOWLIST_HOSTS || '').trim();
  if (!raw) return [];
  return raw.split(',').map((h) => h.trim()).filter(Boolean);
};

const extractActorData = (json) => {
  const actorUri = json?.id;
  const inboxUrl = json?.inbox;
  const sharedInboxUrl = json?.endpoints?.sharedInbox;
  const publicKeyPem = json?.publicKey?.publicKeyPem;

  return {
    actorUri,
    inboxUrl,
    sharedInboxUrl,
    publicKeyPem
  };
};

const parseAcct = (value) => {
  let raw = String(value || '').trim();
  if (!raw) return null;

  if (raw.toLowerCase().startsWith('acct:')) raw = raw.slice(5);
  if (raw.startsWith('@')) raw = raw.slice(1);

  const at = raw.indexOf('@');
  if (at <= 0 || at === raw.length - 1) return null;
  if (raw.indexOf('@', at + 1) !== -1) return null;

  const username = raw.slice(0, at).trim();
  const domain = raw.slice(at + 1).trim().toLowerCase();
  if (!username || !domain) return null;

  return { username, domain };
};

const resolveActorUriFromAcct = async (acctInput) => {
  const parsed = parseAcct(acctInput);
  if (!parsed) {
    throw new Error('Invalid ActivityPub account handle');
  }

  const resource = `acct:${parsed.username}@${parsed.domain}`;
  const url = new URL(`https://${parsed.domain}/.well-known/webfinger`);
  url.searchParams.set('resource', resource);

  const allowPrivate = getAllowPrivateNetworks();
  const allowHosts = getAllowHosts();
  const safeUrl = await assertSsrfSafeUrl(url.toString(), { allowPrivate, allowHosts });

  const { res, json } = await fetchJson(safeUrl.toString(), {
    headers: {
      accept: 'application/jrd+json, application/json'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch WebFinger: HTTP ${res.status}`);
  }

  const links = Array.isArray(json?.links) ? json.links : [];
  const actorLink = links.find((link) => {
    if (!link || link.rel !== 'self' || typeof link.href !== 'string') return false;
    const type = String(link.type || '').toLowerCase();
    if (!type) return true;
    return type.includes('activity+json') || type.includes('ld+json');
  });

  if (!actorLink?.href) {
    throw new Error('WebFinger did not include an ActivityPub actor link');
  }

  return stripFragment(actorLink.href);
};

const upsertRemoteActor = async ({ actorUri, inboxUrl, sharedInboxUrl, publicKeyPem, etag }) => {
  await db.query(
    `INSERT INTO ap_remote_actors (actor_uri, inbox_url, shared_inbox_url, public_key_pem, etag, fetched_at, last_seen)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (actor_uri) DO UPDATE
       SET inbox_url = EXCLUDED.inbox_url,
           shared_inbox_url = EXCLUDED.shared_inbox_url,
           public_key_pem = EXCLUDED.public_key_pem,
           etag = EXCLUDED.etag,
           fetched_at = NOW(),
           last_seen = NOW()`,
    [actorUri, inboxUrl || null, sharedInboxUrl || null, publicKeyPem || null, etag || null]
  );
};

const fetchRemoteActor = async (actorUri) => {
  const normalized = stripFragment(actorUri);
  if (!normalized) throw new Error('Missing actor URI');

  const cached = await db.query(
    `SELECT actor_uri, inbox_url, shared_inbox_url, public_key_pem, fetched_at
     FROM ap_remote_actors
     WHERE actor_uri = $1`,
    [normalized]
  );

  if (cached.rows.length > 0) {
    const row = cached.rows[0];
    const ageMs = Date.now() - new Date(row.fetched_at).getTime();
    if (ageMs < CACHE_TTL_MS && row.inbox_url && row.public_key_pem) {
      await db.query('UPDATE ap_remote_actors SET last_seen = NOW() WHERE actor_uri = $1', [normalized]);
      return {
        actorUri: row.actor_uri,
        inboxUrl: row.inbox_url,
        sharedInboxUrl: row.shared_inbox_url,
        publicKeyPem: row.public_key_pem
      };
    }
  }

  const allowPrivate = getAllowPrivateNetworks();
  const allowHosts = getAllowHosts();
  const url = await assertSsrfSafeUrl(normalized, { allowPrivate, allowHosts });

  const headers = {
    accept: `${ACTIVITY_JSON}, application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\"`
  };

  const { res, json } = await fetchJson(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch actor: HTTP ${res.status}`);
  }

  const extracted = extractActorData(json);
  if (!extracted.actorUri || extracted.actorUri !== normalized) {
    // Be strict: the actor document should self-identify as the URL we fetched.
    throw new Error('Actor ID mismatch');
  }
  if (!extracted.inboxUrl || !extracted.publicKeyPem) {
    throw new Error('Actor missing inbox/publicKey');
  }

  const etag = res.headers.get('etag');
  await upsertRemoteActor({ ...extracted, etag });

  return extracted;
};

const resolveActorUri = async (value) => {
  const input = String(value || '').trim();
  if (!input) throw new Error('Missing actor identifier');
  if (isHttpUrl(input)) return stripFragment(input);
  return resolveActorUriFromAcct(input);
};

const getRemoteActorByKeyId = async (keyId) => {
  const actorUri = stripFragment(keyId);
  return fetchRemoteActor(actorUri);
};

module.exports = {
  fetchRemoteActor,
  getRemoteActorByKeyId,
  resolveActorUri
};
