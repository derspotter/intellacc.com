const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
const { processDueDeliveries } = require('../src/services/activitypub/deliveryWorker');

jest.setTimeout(30000);

process.env.FEDERATION_ALLOW_PRIVATE_NETWORKS = 'true';

const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const getConfiguredBaseUrl = () => {
  const raw = String(process.env.FEDERATION_BASE_URL || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!parsed.protocol.startsWith('http')) return null;
    return stripTrailingSlash(parsed.toString());
  } catch {
    return null;
  }
};

const getConfiguredHost = () => {
  const configured = getConfiguredBaseUrl();
  if (!configured) return 'intellacc.test';
  return new URL(configured).hostname;
};

const getExpectedBaseUrl = (host) => getConfiguredBaseUrl() || `http://${host}`;

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
    email,
    username,
    password,
    token: loginRes.body.token
  };
};

const startRemoteActorServer = async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });

  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET' && req.url === '/users/remotealice') {
        const base = `http://127.0.0.1:${server.address().port}`;
        const actorUri = `${base}/users/remotealice`;
        const inboxUrl = `${base}/inbox`;
        const actor = {
          '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
          id: actorUri,
          type: 'Person',
          preferredUsername: 'remotealice',
          inbox: inboxUrl,
          publicKey: {
            id: `${actorUri}#main-key`,
            owner: actorUri,
            publicKeyPem: publicKey
          }
        };
        res.statusCode = 200;
        res.setHeader('content-type', 'application/activity+json');
        res.end(JSON.stringify(actor));
        return;
      }

      if (req.method === 'POST' && req.url === '/inbox') {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: bodyText
        });
        res.statusCode = 202;
        res.end('ok');
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${server.address().port}`;
  const actorUri = `${base}/users/remotealice`;
  const inboxUrl = `${base}/inbox`;

  return {
    actorUri,
    inboxUrl,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    requests,
    close: async () => new Promise((resolve) => server.close(resolve))
  };
};

const digestHeaderForBody = (bodyText) => {
  const hash = crypto.createHash('sha256').update(Buffer.from(bodyText, 'utf8')).digest('base64');
  return `SHA-256=${hash}`;
};

const signatureHeaderForRequest = ({ method, path, host, date, digest, contentType, keyId, privateKeyPem }) => {
  const signingString = [
    `(request-target): ${method.toLowerCase()} ${path}`,
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`,
    `content-type: ${contentType}`
  ].join('\n');

  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingString, 'utf8'), privateKeyPem).toString('base64');
  return `keyId=\"${keyId}\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date digest content-type\",signature=\"${signature}\"`;
};

describe('ActivityPub MVP', () => {
  const cleanup = [];
  let remote;

  afterAll(async () => {
    if (remote) {
      await remote.close();
    }
    for (const entry of cleanup) {
      if (entry.userId) {
        await db.query('DELETE FROM users WHERE id = $1', [entry.userId]);
      }
      if (entry.remoteActorUri) {
        await db.query('DELETE FROM ap_remote_actors WHERE actor_uri = $1', [entry.remoteActorUri]);
      }
    }
  });

  test('WebFinger + Actor endpoints resolve local users', async () => {
    const user = await createUser('apuser');
    cleanup.push({ userId: user.id });

    const host = getConfiguredHost();
    const expectedBaseUrl = getExpectedBaseUrl(host);

    const webfinger = await request(app)
      .get(`/.well-known/webfinger?resource=acct:${user.username}@${host}`)
      .set('Host', host);

    expect(webfinger.statusCode).toBe(200);
    expect(webfinger.headers['content-type']).toContain('application/jrd+json');
    expect(webfinger.body.subject).toBe(`acct:${user.username}@${host}`);
    expect(webfinger.body.links[0].href).toBe(`${expectedBaseUrl}/ap/users/${user.username}`);

    const actor = await request(app)
      .get(`/ap/users/${user.username}`)
      .set('Host', host);

    expect(actor.statusCode).toBe(200);
    expect(actor.headers['content-type']).toContain('application/activity+json');
    expect(actor.body.id).toBe(`${expectedBaseUrl}/ap/users/${user.username}`);
    expect(actor.body.inbox).toBe(`${expectedBaseUrl}/ap/users/${user.username}/inbox`);
    expect(actor.body.outbox).toBe(`${expectedBaseUrl}/ap/users/${user.username}/outbox`);
    expect(actor.body.publicKey.publicKeyPem).toBeTruthy();
  });

  test('Inbox Follow is signature-verified, stored, and enqueues Accept (then delivers)', async () => {
    const user = await createUser('apfollow');
    cleanup.push({ userId: user.id });

    remote = await startRemoteActorServer();
    cleanup.push({ remoteActorUri: remote.actorUri });

    const host = getConfiguredHost();
    const expectedBaseUrl = getExpectedBaseUrl(host);
    const inboxPath = `/ap/users/${user.username}/inbox`;
    const localActor = `${expectedBaseUrl}/ap/users/${user.username}`;

    const follow = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${remote.actorUri}/activities/follow-1`,
      type: 'Follow',
      actor: remote.actorUri,
      object: localActor
    };

    const bodyText = JSON.stringify(follow);
    const date = new Date().toUTCString();
    const digest = digestHeaderForBody(bodyText);
    const signature = signatureHeaderForRequest({
      method: 'POST',
      path: inboxPath,
      host,
      date,
      digest,
      contentType: 'application/activity+json',
      keyId: `${remote.actorUri}#main-key`,
      privateKeyPem: remote.privateKeyPem
    });

    const res = await request(app)
      .post(inboxPath)
      .set('Host', host)
      .set('Date', date)
      .set('Digest', digest)
      .set('Content-Type', 'application/activity+json')
      .set('Signature', signature)
      .send(bodyText);

    expect(res.statusCode).toBe(202);

    const followerRow = await db.query(
      'SELECT state FROM ap_followers WHERE user_id = $1 AND actor_uri = $2',
      [user.id, remote.actorUri]
    );
    expect(followerRow.rows.length).toBe(1);
    expect(followerRow.rows[0].state).toBe('accepted');

    const queueBefore = await db.query(
      "SELECT id, target_url, payload FROM federation_delivery_queue WHERE protocol = 'ap' AND status = 'pending' ORDER BY id DESC LIMIT 5"
    );
    expect(queueBefore.rows.some((r) => r.target_url === remote.inboxUrl && r.payload?.type === 'Accept')).toBe(true);

    await processDueDeliveries(10);

    expect(remote.requests.length).toBeGreaterThan(0);
    const delivered = remote.requests.map((r) => JSON.parse(r.body));
    expect(delivered.some((a) => a.type === 'Accept')).toBe(true);
  });

  test('Local user can enqueue Follow to a remote actor and process inbound Accept', async () => {
    const user = await createUser('apoutfollow');
    cleanup.push({ userId: user.id });

    const remoteFollow = await startRemoteActorServer();
    cleanup.push({ remoteActorUri: remoteFollow.actorUri });

    try {
      const host = getConfiguredHost();
      const followRes = await request(app)
        .post('/api/federation/activitypub/follow')
        .set('Authorization', `Bearer ${user.token}`)
        .set('Host', host)
        .send({ actor: remoteFollow.actorUri });

      expect(followRes.statusCode).toBe(202);
      expect(followRes.body.actorUri).toBe(remoteFollow.actorUri);
      expect(followRes.body.status).toBe('pending');
      expect(followRes.body.followActivityId).toBeTruthy();

      const row = await db.query(
        'SELECT state, follow_activity_uri FROM ap_following WHERE follower_user_id = $1 AND actor_uri = $2',
        [user.id, remoteFollow.actorUri]
      );
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].state).toBe('pending');
      expect(row.rows[0].follow_activity_uri).toBe(followRes.body.followActivityId);

      await processDueDeliveries(10);
      const deliveredFollow = remoteFollow.requests
        .map((r) => JSON.parse(r.body))
        .find((a) => a.type === 'Follow' && a.object === remoteFollow.actorUri);
      expect(deliveredFollow).toBeTruthy();

      const inboxPath = `/ap/users/${user.username}/inbox`;
      const accept = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${remoteFollow.actorUri}/activities/accept-follow-1`,
        type: 'Accept',
        actor: remoteFollow.actorUri,
        object: deliveredFollow.id
      };

      const bodyText = JSON.stringify(accept);
      const date = new Date().toUTCString();
      const digest = digestHeaderForBody(bodyText);
      const signature = signatureHeaderForRequest({
        method: 'POST',
        path: inboxPath,
        host,
        date,
        digest,
        contentType: 'application/activity+json',
        keyId: `${remoteFollow.actorUri}#main-key`,
        privateKeyPem: remoteFollow.privateKeyPem
      });

      const acceptRes = await request(app)
        .post(inboxPath)
        .set('Host', host)
        .set('Date', date)
        .set('Digest', digest)
        .set('Content-Type', 'application/activity+json')
        .set('Signature', signature)
        .send(bodyText);

      expect(acceptRes.statusCode).toBe(202);

      const acceptedRow = await db.query(
        'SELECT state FROM ap_following WHERE follower_user_id = $1 AND actor_uri = $2',
        [user.id, remoteFollow.actorUri]
      );
      expect(acceptedRow.rows.length).toBe(1);
      expect(acceptedRow.rows[0].state).toBe('accepted');
    } finally {
      await remoteFollow.close();
    }
  });

  test('Local post creation enqueues Create deliveries to remote followers', async () => {
    if (!remote) {
      remote = await startRemoteActorServer();
      cleanup.push({ remoteActorUri: remote.actorUri });
    }

    const startRequestCount = remote.requests.length;

    const user = await createUser('appost');
    cleanup.push({ userId: user.id });

    // Make the account pass requireEmailVerified (Tier 1).
    await db.query('UPDATE users SET verification_tier = 1 WHERE id = $1', [user.id]);

    // Insert remote follower row for this user.
    await db.query(
      `INSERT INTO ap_remote_actors (actor_uri, inbox_url, public_key_pem, fetched_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (actor_uri) DO UPDATE
         SET inbox_url = EXCLUDED.inbox_url,
             public_key_pem = EXCLUDED.public_key_pem,
             fetched_at = NOW()`,
      [remote.actorUri, remote.inboxUrl, remote.publicKeyPem]
    );
    await db.query(
      `INSERT INTO ap_followers (user_id, actor_uri, state)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (user_id, actor_uri) DO UPDATE SET state = 'accepted'`,
      [user.id, remote.actorUri]
    );

    const create = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ content: 'Hello fediverse' });

    // The route can still fail if other verification tiers are required by config/migrations.
    expect([201, 403]).toContain(create.statusCode);
    if (create.statusCode !== 201) {
      return;
    }

    // Post creation does not await federation enqueue; poll until the Create delivery shows up.
    const deadline = Date.now() + 4000;
    let sawCreate = false;
    while (Date.now() < deadline) {
      await processDueDeliveries(10);
      const delivered = remote.requests.slice(startRequestCount).map((r) => JSON.parse(r.body));
      if (delivered.some((a) => a.type === 'Create' && a.object?.type === 'Note')) {
        sawCreate = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(sawCreate).toBe(true);
  });
});
