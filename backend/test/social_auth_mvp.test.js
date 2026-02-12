const http = require('http');
const request = require('supertest');
const db = require('../src/db');

const mockAuthorize = jest.fn();
const mockCallback = jest.fn();
const mockGetProfile = jest.fn();

jest.mock('../src/services/atproto/oauthClientService', () => ({
  getOAuthClient: () => ({
    authorize: mockAuthorize,
    callback: mockCallback
  }),
  getClientMetadata: () => ({
    client_id: 'https://intellacc.test/api/federation/atproto/client-metadata.json',
    redirect_uris: [
      'https://intellacc.test/api/federation/atproto/oauth/callback',
      'https://intellacc.test/api/auth/atproto/callback'
    ]
  }),
  getFederationRedirectUri: () => 'https://intellacc.test/api/federation/atproto/oauth/callback',
  getSocialRedirectUri: () => 'https://intellacc.test/api/auth/atproto/callback',
  restoreOAuthSessionByDid: jest.fn(),
  clearOAuthClientForTests: jest.fn()
}));

jest.mock('@atproto/api', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    getProfile: mockGetProfile
  }))
}));

const { app } = require('../src/index');

jest.setTimeout(30000);

const createdUserIds = [];

const ensureSocialAuthTables = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS federated_auth_identities (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      external_username TEXT,
      profile_url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, subject),
      UNIQUE (provider, user_id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS social_oauth_state (
      state_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      payload_encrypted TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS atproto_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      pds_url TEXT,
      did TEXT,
      handle TEXT,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query('ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS pds_url TEXT');
  await db.query('ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS did TEXT');
  await db.query('ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS handle TEXT');
  await db.query('ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT TRUE');
  await db.query('ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()');
  await db.query('ALTER TABLE atproto_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()');
};

const trackUserByToken = async (token) => {
  const me = await request(app)
    .get('/api/me')
    .set('Authorization', `Bearer ${token}`);
  expect(me.statusCode).toBe(200);
  createdUserIds.push(me.body.id);
  return me.body;
};

const startFakeMastodon = async () => {
  const state = {
    appCalls: 0,
    tokenCalls: 0,
    verifyCalls: 0,
    lastAuthHeader: null,
    lastTokenBody: null
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const formBody = new URLSearchParams(bodyText || '');

      if (req.method === 'POST' && req.url === '/api/v1/apps') {
        state.appCalls += 1;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          client_id: 'masto-client-id',
          client_secret: 'masto-client-secret'
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/oauth/token') {
        state.tokenCalls += 1;
        state.lastTokenBody = Object.fromEntries(formBody.entries());
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          access_token: 'mastodon-access-token',
          token_type: 'Bearer',
          scope: 'read:accounts',
          created_at: Math.floor(Date.now() / 1000)
        }));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/v1/accounts/verify_credentials') {
        state.verifyCalls += 1;
        state.lastAuthHeader = String(req.headers.authorization || '');
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'acct-42',
          username: 'masto_user',
          acct: 'masto_user',
          display_name: 'Masto User',
          url: 'https://mastodon.example/@masto_user',
          avatar: 'https://mastodon.example/avatars/42.png'
        }));
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  };
};

describe('Social Auth MVP (ATProto + Mastodon login)', () => {
  beforeAll(async () => {
    process.env.APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || 'https://intellacc.test';
    await ensureSocialAuthTables();
  });

  beforeEach(() => {
    mockAuthorize.mockReset();
    mockCallback.mockReset();
    mockGetProfile.mockReset();

    mockAuthorize.mockResolvedValue(new URL('https://auth.bsky.example/authorize?state=fake-state'));
    mockCallback.mockResolvedValue({
      session: {
        did: 'did:plc:loginuser123',
        serverMetadata: {
          issuer: 'https://bsky.social'
        }
      },
      state: JSON.stringify({ flow: 'login' })
    });
    mockGetProfile.mockResolvedValue({
      data: {
        handle: 'login.user.bsky.social',
        displayName: 'Login User'
      }
    });
  });

  afterAll(async () => {
    for (const userId of createdUserIds) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  test('ATProto social login creates or signs in user and issues JWT', async () => {
    const start = await request(app)
      .post('/api/auth/atproto/start')
      .send({ identifier: 'login.user.bsky.social' });

    expect(start.statusCode).toBe(200);
    expect(start.body.authorizationUrl).toContain('https://auth.bsky.example/authorize');
    expect(mockAuthorize).toHaveBeenCalledWith(
      'login.user.bsky.social',
      expect.objectContaining({
        state: expect.any(String),
        redirect_uri: 'https://intellacc.test/api/auth/atproto/callback'
      })
    );

    const callback = await request(app)
      .get('/api/auth/atproto/callback?code=test-code&state=anything');

    expect(callback.statusCode).toBe(200);
    expect(callback.body.provider).toBe('atproto');
    expect(callback.body.token).toBeTruthy();

    const me = await trackUserByToken(callback.body.token);
    expect(me.username).toContain('login_user_bsky_social');

    const identity = await db.query(
      `SELECT user_id, provider, subject, external_username
       FROM federated_auth_identities
       WHERE provider = 'atproto' AND subject = $1`,
      ['did:plc:loginuser123']
    );
    expect(identity.rows.length).toBe(1);
    expect(identity.rows[0].user_id).toBe(me.id);
    expect(identity.rows[0].external_username).toBe('login.user.bsky.social');

    const linkedAtproto = await db.query(
      'SELECT user_id, did, handle FROM atproto_accounts WHERE user_id = $1',
      [me.id]
    );
    expect(linkedAtproto.rows.length).toBe(1);
    expect(linkedAtproto.rows[0].did).toBe('did:plc:loginuser123');
  });

  test('Mastodon social login creates or signs in user and issues JWT', async () => {
    const fakeMasto = await startFakeMastodon();

    try {
      const start = await request(app)
        .post('/api/auth/mastodon/start')
        .send({ instance: fakeMasto.origin });

      expect(start.statusCode).toBe(200);
      expect(start.body.authorizationUrl).toContain(`${fakeMasto.origin}/oauth/authorize`);
      expect(fakeMasto.state.appCalls).toBe(1);

      const state = new URL(start.body.authorizationUrl).searchParams.get('state');
      expect(state).toBeTruthy();

      const callback = await request(app)
        .get(`/api/auth/mastodon/callback?code=sample-code&state=${encodeURIComponent(state)}`);

      expect(callback.statusCode).toBe(200);
      expect(callback.body.provider).toBe('mastodon');
      expect(callback.body.token).toBeTruthy();
      expect(fakeMasto.state.tokenCalls).toBe(1);
      expect(fakeMasto.state.verifyCalls).toBe(1);
      expect(fakeMasto.state.lastAuthHeader).toBe('Bearer mastodon-access-token');
      expect(fakeMasto.state.lastTokenBody.grant_type).toBe('authorization_code');

      const me = await trackUserByToken(callback.body.token);

      const subject = `${fakeMasto.origin}|acct-42`;
      const identity = await db.query(
        `SELECT user_id, provider, subject, external_username
         FROM federated_auth_identities
         WHERE provider = 'mastodon' AND subject = $1`,
        [subject]
      );

      expect(identity.rows.length).toBe(1);
      expect(identity.rows[0].user_id).toBe(me.id);
      expect(identity.rows[0].external_username).toBe('masto_user');

      const repeatStart = await request(app)
        .post('/api/auth/mastodon/start')
        .send({ instance: fakeMasto.origin });
      const repeatState = new URL(repeatStart.body.authorizationUrl).searchParams.get('state');

      const repeatCallback = await request(app)
        .get(`/api/auth/mastodon/callback?code=sample-code-2&state=${encodeURIComponent(repeatState)}`);

      expect(repeatCallback.statusCode).toBe(200);
      const repeatMe = await request(app)
        .get('/api/me')
        .set('Authorization', `Bearer ${repeatCallback.body.token}`);
      expect(repeatMe.statusCode).toBe(200);
      expect(repeatMe.body.id).toBe(me.id);
    } finally {
      await fakeMasto.close();
    }
  });
});
