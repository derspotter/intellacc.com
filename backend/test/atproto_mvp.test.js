const request = require('supertest');

const mockAuthorize = jest.fn();
const mockCallback = jest.fn();
const mockRestore = jest.fn();
const mockRevoke = jest.fn();

const mockAgentPost = jest.fn();
const mockAgentGetProfile = jest.fn();

jest.mock('@atproto/oauth-client-node', () => {
  return {
    NodeOAuthClient: jest.fn().mockImplementation((options = {}) => {
      return {
        clientMetadata: options.clientMetadata || {},
        authorize: mockAuthorize,
        callback: mockCallback,
        restore: mockRestore,
        revoke: mockRevoke
      };
    })
  };
});

jest.mock('@atproto/api', () => {
  return {
    Agent: jest.fn().mockImplementation(() => {
      return {
        post: mockAgentPost,
        getProfile: mockAgentGetProfile
      };
    })
  };
});

const { app } = require('../src/index');
const db = require('../src/db');
const { processDueDeliveries } = require('../src/services/atproto/deliveryWorker');
const { clearOAuthClientForTests } = require('../src/services/atproto/oauthClientService');

jest.setTimeout(30000);

const createUser = async (label) => {
  const unique = Date.now() + Math.floor(Math.random() * 10000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  const password = 'testpass123';

  await request(app)
    .post('/api/users/register')
    .send({ username, email, password });

  const loginRes = await request(app)
    .post('/api/login')
    .send({ email, password });

  const userRow = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  return {
    id: userRow.rows[0].id,
    username,
    token: loginRes.body.token
  };
};

const ensureAtprotoTables = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS atproto_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      pds_url TEXT,
      did TEXT,
      handle TEXT,
      access_jwt_encrypted TEXT,
      refresh_jwt_encrypted TEXT,
      session_expires_at TIMESTAMPTZ,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS atproto_oauth_state (
      key TEXT PRIMARY KEY,
      state_encrypted TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS atproto_oauth_session (
      sub TEXT PRIMARY KEY,
      session_encrypted TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS atproto_post_map (
      post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at_uri TEXT NOT NULL UNIQUE,
      at_cid TEXT,
      record_rkey TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS atproto_delivery_queue (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('create_post')),
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_attempt_at TIMESTAMPTZ,
      last_status_code INTEGER,
      last_error TEXT,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, post_id, kind)
    )
  `);
};

describe('ATProto MVP (OAuth-only)', () => {
  const cleanupUserIds = [];

  beforeAll(async () => {
    process.env.APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || process.env.FEDERATION_BASE_URL || 'https://intellacc.test';
    await ensureAtprotoTables();
  });

  beforeEach(() => {
    clearOAuthClientForTests();

    mockAuthorize.mockReset();
    mockCallback.mockReset();
    mockRestore.mockReset();
    mockRevoke.mockReset();
    mockAgentPost.mockReset();
    mockAgentGetProfile.mockReset();

    mockAuthorize.mockResolvedValue(new URL('https://auth.bsky.example/authorize?state=fake-state'));
    mockRestore.mockResolvedValue({ did: 'did:plc:testuser123' });
    mockAgentPost.mockResolvedValue({
      uri: 'at://did:plc:testuser123/app.bsky.feed.post/post-1',
      cid: 'bafytest1'
    });
    mockAgentGetProfile.mockResolvedValue({
      data: {
        handle: 'fake.handle.test'
      }
    });
  });

  afterAll(async () => {
    for (const userId of cleanupUserIds) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  test('oauth start + callback links account, publishes queued post, and disconnect revokes session', async () => {
    const metadataRes = await request(app)
      .get('/api/federation/atproto/client-metadata.json');

    expect(metadataRes.statusCode).toBe(200);
    expect(metadataRes.body.client_id).toContain('/api/federation/atproto/client-metadata.json');
    expect(metadataRes.body.redirect_uris.some((uri) => uri.endsWith('/api/federation/atproto/oauth/callback'))).toBe(true);
    expect(metadataRes.body.redirect_uris.some((uri) => uri.endsWith('/api/auth/atproto/callback'))).toBe(true);

    const user = await createUser('atproto_oauth');
    cleanupUserIds.push(user.id);

    const startRes = await request(app)
      .post('/api/federation/atproto/oauth/start')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ identifier: 'fake.handle.test' });

    expect(startRes.statusCode).toBe(200);
    expect(startRes.body.authorizationUrl).toContain('https://auth.bsky.example/authorize');

    const authorizeOptions = mockAuthorize.mock.calls[0][1] || {};
    const passedState = authorizeOptions.state;
    expect(passedState).toBeTruthy();
    expect(authorizeOptions.redirect_uri).toMatch(/\/api\/federation\/atproto\/oauth\/callback$/);

    mockCallback.mockResolvedValueOnce({
      session: {
        did: 'did:plc:testuser123',
        serverMetadata: { issuer: 'https://bsky.social' }
      },
      state: passedState
    });

    const callbackRes = await request(app)
      .get('/api/federation/atproto/oauth/callback?code=test-code&state=fake-state');

    expect(callbackRes.statusCode).toBe(200);
    expect(callbackRes.body.ok).toBe(true);
    expect(callbackRes.body.account.did).toBe('did:plc:testuser123');

    const accountRes = await request(app)
      .get('/api/federation/atproto/account')
      .set('Authorization', `Bearer ${user.token}`);

    expect(accountRes.statusCode).toBe(200);
    expect(accountRes.body.account).toBeTruthy();
    expect(accountRes.body.account.did).toBe('did:plc:testuser123');

    const postInsert = await db.query(
      `INSERT INTO posts (user_id, content, parent_id, is_comment, created_at, updated_at)
       VALUES ($1, $2, NULL, FALSE, NOW(), NOW())
       RETURNING id`,
      [user.id, 'Hello AT Protocol from OAuth MVP test']
    );
    const postId = postInsert.rows[0].id;

    const enqueueRes = await request(app)
      .post(`/api/federation/atproto/posts/${postId}/enqueue`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({});

    expect(enqueueRes.statusCode).toBe(202);

    await processDueDeliveries(10);

    const mapped = await db.query(
      'SELECT at_uri, at_cid FROM atproto_post_map WHERE post_id = $1',
      [postId]
    );

    expect(mapped.rows.length).toBe(1);
    expect(mapped.rows[0].at_uri).toContain('at://did:plc:testuser123/app.bsky.feed.post/');
    expect(mapped.rows[0].at_cid).toBe('bafytest1');

    expect(mockRestore).toHaveBeenCalledWith('did:plc:testuser123', 'auto');
    expect(mockAgentPost).toHaveBeenCalledTimes(1);

    const disconnectRes = await request(app)
      .delete('/api/federation/atproto/account')
      .set('Authorization', `Bearer ${user.token}`);

    expect(disconnectRes.statusCode).toBe(204);
    expect(mockRevoke).toHaveBeenCalledWith('did:plc:testuser123');

    const afterDisconnect = await request(app)
      .get('/api/federation/atproto/account')
      .set('Authorization', `Bearer ${user.token}`);

    expect(afterDisconnect.statusCode).toBe(200);
    expect(afterDisconnect.body.account).toBeNull();
  });
});
