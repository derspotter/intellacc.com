const { Agent } = require('@atproto/api');
const { generateToken } = require('../utils/jwt');
const atprotoAccountService = require('../services/atproto/accountService');
const {
  getOAuthClient,
  getSocialRedirectUri
} = require('../services/atproto/oauthClientService');
const socialAuthService = require('../services/socialAuthService');
const { createOAuthState, consumeOAuthState } = require('../services/socialOAuthStateService');

const DEFAULT_MASTODON_SCOPE = String(process.env.MASTODON_OAUTH_SCOPES || 'read:accounts').trim() || 'read:accounts';

const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const shouldRedirect = (value) => {
  const lowered = String(value || '').trim().toLowerCase();
  return lowered === '1' || lowered === 'true' || lowered === 'yes';
};

const getPublicBaseUrl = (req) => {
  const configured = stripTrailingSlash(process.env.APP_PUBLIC_URL || process.env.FEDERATION_BASE_URL || '');
  if (configured) return configured;

  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return stripTrailingSlash(`${protocol}://${host}`);
};

const getFrontendBaseUrl = () => {
  const configured = stripTrailingSlash(process.env.FRONTEND_URL || '');
  return configured || null;
};

const buildJwtResponse = (user) => {
  const token = generateToken({
    userId: user.id,
    role: user.role || 'user'
  });

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role || 'user'
    }
  };
};

const respondWithLogin = (req, res, payload, redirectEnabled) => {
  if (!redirectEnabled) {
    return res.status(200).json(payload);
  }

  const frontendBase = getFrontendBaseUrl();
  if (!frontendBase) {
    return res.status(200).json(payload);
  }

  const redirectUrl = new URL(`${frontendBase}/#login`);
  const params = new URLSearchParams();
  params.set('socialToken', payload.token);
  params.set('provider', payload.provider);
  redirectUrl.hash = `login?${params.toString()}`;

  return res.redirect(302, redirectUrl.toString());
};

const jsonFetch = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.headers || {})
      }
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      const err = new Error(data?.error_description || data?.error || data?.message || `HTTP ${res.status}`);
      err.statusCode = res.status;
      err.payload = data;
      throw err;
    }

    return data || {};
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeMastodonInstance = (raw) => {
  const input = String(raw || '').trim();
  if (!input) throw new Error('instance is required');

  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('Invalid Mastodon instance URL');
  }

  if (!parsed.hostname) {
    throw new Error('Invalid Mastodon instance URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Unsupported Mastodon protocol');
  }

  return `${parsed.protocol}//${parsed.host}`;
};

exports.startAtprotoLogin = async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || req.body?.handle || '').trim();
    if (!identifier) {
      return res.status(400).json({ error: 'identifier is required' });
    }

    const redirect = shouldRedirect(req.body?.redirect || req.query?.redirect);
    const state = JSON.stringify({ flow: 'login', redirect });
    const authorizationUrl = await getOAuthClient().authorize(identifier, {
      state,
      redirect_uri: getSocialRedirectUri()
    });

    return res.status(200).json({ authorizationUrl: String(authorizationUrl) });
  } catch (err) {
    console.error('[SocialAuth] ATProto login start failed:', err?.message || err);
    return res.status(500).json({ error: 'Failed to start ATProto login' });
  }
};

exports.finishAtprotoLogin = async (req, res) => {
  try {
    const queryIdx = String(req.originalUrl || '').indexOf('?');
    const queryString = queryIdx === -1 ? '' : String(req.originalUrl).slice(queryIdx + 1);
    const params = new URLSearchParams(queryString);

    const { session, state } = await getOAuthClient().callback(params, {
      redirect_uri: getSocialRedirectUri()
    });
    const did = session?.did;
    if (!did) {
      return res.status(400).json({ error: 'Invalid ATProto session' });
    }

    let stateData = {};
    try {
      stateData = JSON.parse(String(state || '{}'));
    } catch {
      stateData = {};
    }

    let externalHandle = did;
    let displayName = null;

    try {
      const agent = new Agent(session);
      const profile = await agent.getProfile({ actor: did });
      externalHandle = String(profile?.data?.handle || did);
      displayName = String(profile?.data?.displayName || '').trim() || null;
    } catch (profileErr) {
      console.warn('[SocialAuth] ATProto profile lookup failed:', profileErr?.message || profileErr);
    }

    const user = await socialAuthService.getOrCreateUserFromIdentity({
      provider: 'atproto',
      subject: did,
      usernameHint: externalHandle,
      externalUsername: externalHandle,
      profileUrl: `https://bsky.app/profile/${encodeURIComponent(externalHandle)}`,
      metadata: {
        did,
        handle: externalHandle,
        displayName,
        issuer: session?.serverMetadata?.issuer || null
      }
    });

    try {
      await atprotoAccountService.upsertLinkedAccount({
        userId: user.id,
        did,
        handle: externalHandle,
        pdsUrl: session?.serverMetadata?.issuer || 'https://bsky.social'
      });
    } catch (linkErr) {
      console.warn('[SocialAuth] Failed to auto-link ATProto publishing account:', linkErr?.message || linkErr);
    }

    const payload = {
      provider: 'atproto',
      ...buildJwtResponse(user)
    };

    return respondWithLogin(req, res, payload, shouldRedirect(stateData.redirect || req.query?.redirect));
  } catch (err) {
    console.error('[SocialAuth] ATProto login callback failed:', err?.message || err);
    return res.status(400).json({ error: String(err?.message || 'ATProto login failed') });
  }
};

exports.startMastodonLogin = async (req, res) => {
  try {
    const instanceOrigin = normalizeMastodonInstance(req.body?.instance || req.body?.instanceUrl);
    const baseUrl = getPublicBaseUrl(req);
    const redirectUri = `${baseUrl}/api/auth/mastodon/callback`;
    const redirect = shouldRedirect(req.body?.redirect || req.query?.redirect);

    const appRegistration = await jsonFetch(`${instanceOrigin}/api/v1/apps`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        client_name: 'Intellacc',
        redirect_uris: redirectUri,
        scopes: DEFAULT_MASTODON_SCOPE,
        website: baseUrl
      })
    });

    const clientId = String(appRegistration?.client_id || '').trim();
    const clientSecret = String(appRegistration?.client_secret || '').trim();
    if (!clientId || !clientSecret) {
      return res.status(502).json({ error: 'Mastodon app registration failed' });
    }

    const state = await createOAuthState({
      provider: 'mastodon',
      payload: {
        instanceOrigin,
        redirectUri,
        clientId,
        clientSecret,
        scope: DEFAULT_MASTODON_SCOPE,
        redirect
      },
      ttlSeconds: Number(process.env.SOCIAL_AUTH_STATE_TTL_SECONDS || 600)
    });

    const url = new URL(`${instanceOrigin}/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', DEFAULT_MASTODON_SCOPE);
    url.searchParams.set('state', state);

    return res.status(200).json({ authorizationUrl: String(url) });
  } catch (err) {
    const status = err?.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    console.error('[SocialAuth] Mastodon login start failed:', err?.message || err);
    return res.status(status).json({ error: String(err?.message || 'Failed to start Mastodon login') });
  }
};

exports.finishMastodonLogin = async (req, res) => {
  try {
    const state = String(req.query?.state || '').trim();
    const code = String(req.query?.code || '').trim();

    if (!state || !code) {
      return res.status(400).json({ error: 'code and state are required' });
    }

    const authState = await consumeOAuthState({
      provider: 'mastodon',
      stateKey: state
    });

    const tokenResponse = await jsonFetch(`${authState.instanceOrigin}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: authState.clientId,
        client_secret: authState.clientSecret,
        redirect_uri: authState.redirectUri,
        scope: authState.scope || DEFAULT_MASTODON_SCOPE
      }).toString()
    });

    const accessToken = String(tokenResponse?.access_token || '').trim();
    if (!accessToken) {
      return res.status(502).json({ error: 'Mastodon token exchange failed' });
    }

    const account = await jsonFetch(`${authState.instanceOrigin}/api/v1/accounts/verify_credentials`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    const accountId = String(account?.id || '').trim();
    if (!accountId) {
      return res.status(502).json({ error: 'Mastodon account verification failed' });
    }

    const externalUsername = String(account?.acct || account?.username || '').trim() || accountId;
    const subject = `${authState.instanceOrigin}|${accountId}`;

    const user = await socialAuthService.getOrCreateUserFromIdentity({
      provider: 'mastodon',
      subject,
      usernameHint: externalUsername,
      externalUsername,
      profileUrl: String(account?.url || '').trim() || null,
      metadata: {
        instance: authState.instanceOrigin,
        accountId,
        username: account?.username || null,
        acct: account?.acct || null,
        displayName: account?.display_name || null,
        avatar: account?.avatar || null,
        url: account?.url || null
      }
    });

    const payload = {
      provider: 'mastodon',
      ...buildJwtResponse(user)
    };

    return respondWithLogin(req, res, payload, shouldRedirect(authState.redirect || req.query?.redirect));
  } catch (err) {
    const status = err?.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
    console.error('[SocialAuth] Mastodon login callback failed:', err?.message || err);
    return res.status(status).json({ error: String(err?.message || 'Mastodon login failed') });
  }
};
