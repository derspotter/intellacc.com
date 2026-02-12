const { NodeOAuthClient } = require('@atproto/oauth-client-node');
const db = require('../../db');
const { encryptSecret, decryptSecret } = require('./crypto');

const DEFAULT_SCOPE = 'atproto transition:generic';

let oauthClient = null;
let oauthClientMetadata = null;

const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const getPublicBaseUrl = () => {
  const candidate = String(
    process.env.APP_PUBLIC_URL
      || process.env.ATPROTO_PUBLIC_URL
      || process.env.FEDERATION_BASE_URL
      || 'http://localhost:3000'
  ).trim();

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Invalid APP_PUBLIC_URL/ATPROTO_PUBLIC_URL/FEDERATION_BASE_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Unsupported public URL protocol');
  }

  return stripTrailingSlash(parsed.toString());
};

const getOAuthScope = () => {
  const configured = String(process.env.ATPROTO_OAUTH_SCOPES || '').trim();
  return configured || DEFAULT_SCOPE;
};

const getFederationRedirectUri = () => {
  const configured = String(process.env.ATPROTO_OAUTH_REDIRECT_URI || '').trim();
  if (configured) return configured;
  return `${getPublicBaseUrl()}/api/federation/atproto/oauth/callback`;
};

const getSocialRedirectUri = () => {
  return `${getPublicBaseUrl()}/api/auth/atproto/callback`;
};

const getRedirectUris = () => {
  return Array.from(new Set([
    getFederationRedirectUri(),
    getSocialRedirectUri()
  ]));
};

const buildClientMetadata = () => {
  const baseUrl = getPublicBaseUrl();
  const clientId = String(process.env.ATPROTO_OAUTH_CLIENT_ID || '').trim()
    || `${baseUrl}/api/federation/atproto/client-metadata.json`;

  return {
    client_id: clientId,
    client_name: String(process.env.ATPROTO_OAUTH_CLIENT_NAME || 'Intellacc').trim() || 'Intellacc',
    client_uri: baseUrl,
    redirect_uris: getRedirectUris(),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: getOAuthScope(),
    application_type: 'web',
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true
  };
};

const serializeEncrypted = (value) => encryptSecret(JSON.stringify(value || null));

const deserializeEncrypted = (value) => JSON.parse(decryptSecret(value));

const stateStore = {
  async set(key, state) {
    const encrypted = serializeEncrypted(state);
    await db.query(
      `INSERT INTO atproto_oauth_state (key, state_encrypted, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (key) DO UPDATE
         SET state_encrypted = EXCLUDED.state_encrypted,
             updated_at = NOW()`,
      [key, encrypted]
    );
  },
  async get(key) {
    const result = await db.query(
      `SELECT state_encrypted
       FROM atproto_oauth_state
       WHERE key = $1`,
      [key]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return deserializeEncrypted(row.state_encrypted);
  },
  async del(key) {
    await db.query('DELETE FROM atproto_oauth_state WHERE key = $1', [key]);
  }
};

const sessionStore = {
  async set(sub, session) {
    const encrypted = serializeEncrypted(session);
    await db.query(
      `INSERT INTO atproto_oauth_session (sub, session_encrypted, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (sub) DO UPDATE
         SET session_encrypted = EXCLUDED.session_encrypted,
             updated_at = NOW()`,
      [sub, encrypted]
    );
  },
  async get(sub) {
    const result = await db.query(
      `SELECT session_encrypted
       FROM atproto_oauth_session
       WHERE sub = $1`,
      [sub]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return deserializeEncrypted(row.session_encrypted);
  },
  async del(sub) {
    await db.query('DELETE FROM atproto_oauth_session WHERE sub = $1', [sub]);
  }
};

const getOAuthClient = () => {
  if (!oauthClient) {
    oauthClientMetadata = buildClientMetadata();
    oauthClient = new NodeOAuthClient({
      clientMetadata: oauthClientMetadata,
      stateStore,
      sessionStore
    });
  }
  return oauthClient;
};

const getClientMetadata = () => {
  if (!oauthClientMetadata) {
    oauthClientMetadata = buildClientMetadata();
  }
  return oauthClientMetadata;
};

const restoreOAuthSessionByDid = async (did, refresh = 'auto') => {
  return getOAuthClient().restore(did, refresh);
};

const clearOAuthClientForTests = () => {
  oauthClient = null;
  oauthClientMetadata = null;
};

module.exports = {
  getOAuthClient,
  getClientMetadata,
  getFederationRedirectUri,
  getSocialRedirectUri,
  restoreOAuthSessionByDid,
  clearOAuthClientForTests
};
