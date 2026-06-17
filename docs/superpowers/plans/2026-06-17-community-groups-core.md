# Community Groups — Core (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verified users create public theme-groups under a parent topic; anyone browses and joins/leaves them; a group page renders the header + tab scaffold for the feed/chat/markets that follow.

**Architecture:** New `community_groups` + `community_group_members` tables; a `communityGroupsController` exposing `/api/groups*`; van-skin pages `#groups` (browse, layout B) and `#group/:slug`. Membership is a join table with a denormalized `member_count`. Creation is gated by verification tier ≥ 2.

**Tech Stack:** Express + PostgreSQL backend; SolidJS van skin; Jest + supertest (backend), Playwright (smoke).

**Spec:** `docs/superpowers/specs/2026-06-17-community-groups-core-design.md`

**Conventions:**
- Backend tests run in the container: `docker exec intellacc_backend npx jest test/<file> --runInBand`.
- After backend controller/route edits, the running server needs a restart to serve them: `docker restart intellacc_backend` (jest via `docker exec` loads fresh, so a passing test alone doesn't prove the live server updated).
- Frontend dev: `docker compose -p solid-local -f docker-compose.solid-local.yml up -d` (ALWAYS `-p solid-local`), host port 4174.
- Existing helpers to reuse: `requirePhoneVerified` (= `requireTier(2)`) from `middleware/verification`; `db.executeWithTransaction(async (client) => …)`; admin check is `req.user.role === 'admin'`; topics via `GET /api/topics` → `{ topics: [{id, slug, name, ...}] }`.
- Branch off master; merge `--no-ff` at the end.

---

### Task 1: Migration — community group tables

**Files:**
- Create: `backend/migrations/20260617_community_groups.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Community Groups (sub-project A): user-created theme-groups under a parent
-- topic. Distinct from mls_groups (private E2EE chats).
CREATE TABLE IF NOT EXISTS community_groups (
  id           SERIAL PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  topic_id     INT NOT NULL REFERENCES topics(id),
  created_by   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_count INT NOT NULL DEFAULT 0,
  removed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_groups_topic ON community_groups (topic_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_community_groups_members ON community_groups (member_count DESC) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS community_group_members (
  group_id  INT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cgm_user ON community_group_members (user_id);
```

- [ ] **Step 2: Apply it**

Run: `docker exec intellacc_backend sh -lc 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20260617_community_groups.sql'`
Expected: `CREATE TABLE` / `CREATE INDEX` lines, no error.

- [ ] **Step 3: Verify**

Run: `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "\d community_groups" -c "\d community_group_members"`
Expected: both tables with the columns above.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/20260617_community_groups.sql
git commit -m "feat(groups): community_groups + members tables"
```

---

### Task 2: Backend — create / list / get

**Files:**
- Create: `backend/src/controllers/communityGroupsController.js`
- Modify: `backend/src/routes/api.js`
- Test: `backend/test/community_groups.test.js`

- [ ] **Step 1: Write the failing test**

```js
// backend/test/community_groups.test.js
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');

jest.setTimeout(30000);

const createUser = async (label, tier = 0) => {
  const unique = Date.now() + Math.floor(Math.random() * 100000);
  const email = `${label}_${unique}@example.com`;
  const username = `${label}_${unique}`;
  await request(app).post('/api/users/register').send({ username, email, password: 'testpass123' });
  const login = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  const id = row.rows[0].id;
  await db.query('UPDATE users SET verification_tier = $1 WHERE id = $2', [tier, id]);
  return { id, username, token: login.body.token };
};

const firstTopicId = async () => (await db.query('SELECT id FROM topics ORDER BY id LIMIT 1')).rows[0].id;

describe('Community groups — create/list/get', () => {
  const cleanup = { userIds: [], groupIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('create requires tier >= 2; owner becomes member; list + get reflect it', async () => {
    const lowTier = await createUser('cglow', 1);
    const creator = await createUser('cgcreator', 2);
    cleanup.userIds.push(lowTier.id, creator.id);
    const topicId = await firstTopicId();

    const denied = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${lowTier.token}`)
      .send({ name: 'Tier1 group attempt', description: 'x', topic_id: topicId });
    expect(denied.statusCode).toBe(403);

    const created = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${creator.token}`)
      .send({ name: 'BTC 200k 2026 test', description: 'macro case', topic_id: topicId });
    expect(created.statusCode).toBe(201);
    expect(created.body.group.member_count).toBe(1);
    expect(created.body.group.is_member).toBe(true);
    expect(created.body.group.is_owner).toBe(true);
    expect(created.body.group.slug).toBeTruthy();
    cleanup.groupIds.push(created.body.group.id);

    const bad = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${creator.token}`)
      .send({ name: 'x', description: '', topic_id: topicId }); // name too short
    expect(bad.statusCode).toBe(400);

    const list = await request(app).get('/api/groups').query({ topic: topicId })
      .set('Authorization', `Bearer ${creator.token}`);
    expect(list.statusCode).toBe(200);
    const found = list.body.groups.find((g) => g.id === created.body.group.id);
    expect(found).toBeTruthy();
    expect(found.is_member).toBe(true);
    expect(found.topic_name).toBeTruthy();

    const detail = await request(app).get(`/api/groups/${created.body.group.slug}`)
      .set('Authorization', `Bearer ${creator.token}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.group.is_owner).toBe(true);

    const missing = await request(app).get('/api/groups/does-not-exist-slug');
    expect(missing.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker exec intellacc_backend npx jest test/community_groups.test.js --runInBand`
Expected: FAIL (routes 404).

- [ ] **Step 3: Create the controller**

```js
// backend/src/controllers/communityGroupsController.js
const db = require('../db');

const NAME_MIN = 3;
const NAME_MAX = 80;
const DESC_MAX = 500;

const getViewerId = (req) => req.user?.id || req.user?.userId || null;

const slugify = (name) => {
  const base = String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${base || 'group'}-${rand}`;
};

const mapGroup = (row, viewerId) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  topic_id: row.topic_id,
  topic_name: row.topic_name,
  member_count: row.member_count,
  created_by: row.created_by,
  is_member: !!row.is_member,
  is_owner: viewerId != null && Number(row.created_by) === Number(viewerId)
});

exports.listGroups = async (req, res) => {
  const viewerId = getViewerId(req);
  const sort = req.query.sort === 'recent' ? 'g.created_at DESC, g.id DESC' : 'g.member_count DESC, g.id DESC';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const params = [viewerId];
  let where = 'g.removed_at IS NULL';
  const topicId = parseInt(req.query.topic, 10);
  if (Number.isInteger(topicId)) { params.push(topicId); where += ` AND g.topic_id = $${params.length}`; }
  params.push(limit);
  try {
    const result = await db.query(
      `SELECT g.id, g.slug, g.name, g.description, g.topic_id, t.name AS topic_name,
              g.member_count, g.created_by,
              EXISTS (SELECT 1 FROM community_group_members m WHERE m.group_id = g.id AND m.user_id = $1) AS is_member
       FROM community_groups g JOIN topics t ON t.id = g.topic_id
       WHERE ${where}
       ORDER BY ${sort}
       LIMIT $${params.length}`,
      params
    );
    res.json({ groups: result.rows.map((r) => mapGroup(r, viewerId)) });
  } catch (err) {
    console.error('Error listing groups:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  try {
    const result = await db.query(
      `SELECT g.id, g.slug, g.name, g.description, g.topic_id, t.name AS topic_name,
              g.member_count, g.created_by,
              EXISTS (SELECT 1 FROM community_group_members m WHERE m.group_id = g.id AND m.user_id = $2) AS is_member
       FROM community_groups g JOIN topics t ON t.id = g.topic_id
       WHERE g.slug = $1 AND g.removed_at IS NULL`,
      [req.params.slug, viewerId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    res.json({ group: mapGroup(result.rows[0], viewerId) });
  } catch (err) {
    console.error('Error getting group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.createGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const topicId = parseInt(req.body?.topic_id, 10);
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return res.status(400).json({ message: `Name must be ${NAME_MIN}-${NAME_MAX} characters` });
  }
  if (description.length > DESC_MAX) {
    return res.status(400).json({ message: `Description must be at most ${DESC_MAX} characters` });
  }
  if (!Number.isInteger(topicId)) {
    return res.status(400).json({ message: 'A topic is required' });
  }
  try {
    const group = await db.executeWithTransaction(async (client) => {
      const topic = await client.query('SELECT id, name FROM topics WHERE id = $1', [topicId]);
      if (topic.rows.length === 0) { const e = new Error('Topic not found'); e.status = 400; throw e; }
      const ins = await client.query(
        `INSERT INTO community_groups (slug, name, description, topic_id, created_by, member_count)
         VALUES ($1, $2, $3, $4, $5, 1)
         RETURNING id, slug, name, description, topic_id, member_count, created_by`,
        [slugify(name), name, description, topicId, viewerId]
      );
      const g = ins.rows[0];
      await client.query(
        `INSERT INTO community_group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [g.id, viewerId]
      );
      g.topic_name = topic.rows[0].name;
      g.is_member = true;
      return g;
    });
    res.status(201).json({ group: mapGroup(group, viewerId) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    console.error('Error creating group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
```

- [ ] **Step 4: Wire routes**

In `backend/src/routes/api.js`, near the topics routes, add the require and routes. (`authenticateJWT` and `requirePhoneVerified` are already imported in this file.)

```js
const communityGroupsController = require('../controllers/communityGroupsController');
// Community groups (public reads; tier>=2 to create)
router.get('/groups', optionalAuth, communityGroupsController.listGroups);
router.get('/groups/:slug', optionalAuth, communityGroupsController.getGroup);
router.post('/groups', authenticateJWT, requirePhoneVerified, communityGroupsController.createGroup);
```

If `optionalAuth` is not already imported/available in this file, use `authenticateJWT` on the two GETs instead (the browse/detail still work; `is_member` just requires being logged in) — check the top of `api.js` for an existing optional-auth middleware (e.g. the one used by `GET /posts`) and prefer it so logged-out users can browse. Verify by grepping: `grep -n "optionalAuth\|getPosts" backend/src/routes/api.js`.

- [ ] **Step 5: Restart backend and run the test**

```bash
docker restart intellacc_backend && sleep 6
docker exec intellacc_backend npx jest test/community_groups.test.js --runInBand
```
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add backend/src/controllers/communityGroupsController.js backend/src/routes/api.js backend/test/community_groups.test.js
git commit -m "feat(groups): create/list/get endpoints"
```

---

### Task 3: Backend — join / leave membership

**Files:**
- Modify: `backend/src/controllers/communityGroupsController.js`
- Modify: `backend/src/routes/api.js`
- Test: extend `backend/test/community_groups.test.js`

- [ ] **Step 1: Add the failing test** (append inside the `describe`)

```js
  test('join is idempotent and increments; leave decrements (floor 0)', async () => {
    const owner = await createUser('cgown', 2);
    const joiner = await createUser('cgjoin', 0);
    cleanup.userIds.push(owner.id, joiner.id);
    const topicId = await firstTopicId();
    const created = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Joinable group test', description: '', topic_id: topicId });
    const id = created.body.group.id;
    cleanup.groupIds.push(id);

    const join1 = await request(app).post(`/api/groups/${id}/membership`).set('Authorization', `Bearer ${joiner.token}`);
    expect(join1.statusCode).toBe(200);
    expect(join1.body.is_member).toBe(true);
    expect(join1.body.member_count).toBe(2);

    const join2 = await request(app).post(`/api/groups/${id}/membership`).set('Authorization', `Bearer ${joiner.token}`);
    expect(join2.body.member_count).toBe(2); // idempotent

    const leave = await request(app).delete(`/api/groups/${id}/membership`).set('Authorization', `Bearer ${joiner.token}`);
    expect(leave.statusCode).toBe(200);
    expect(leave.body.is_member).toBe(false);
    expect(leave.body.member_count).toBe(1);
  });
```

- [ ] **Step 2: Run it, expect FAIL** (membership routes 404)

Run: `docker exec intellacc_backend npx jest test/community_groups.test.js --runInBand -t 'join is idempotent'`

- [ ] **Step 3: Add controller methods** (append to `communityGroupsController.js`)

```js
exports.joinGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  try {
    const memberCount = await db.executeWithTransaction(async (client) => {
      const g = await client.query('SELECT id FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
      if (g.rows.length === 0) { const e = new Error('Group not found'); e.status = 404; throw e; }
      const ins = await client.query(
        `INSERT INTO community_group_members (group_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, viewerId]
      );
      if (ins.rowCount === 1) {
        await client.query('UPDATE community_groups SET member_count = member_count + 1 WHERE id = $1', [groupId]);
      }
      const cnt = await client.query('SELECT member_count FROM community_groups WHERE id = $1', [groupId]);
      return cnt.rows[0].member_count;
    });
    res.json({ is_member: true, member_count: memberCount });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error('Error joining group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.leaveGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  try {
    const memberCount = await db.executeWithTransaction(async (client) => {
      const del = await client.query(
        'DELETE FROM community_group_members WHERE group_id = $1 AND user_id = $2', [groupId, viewerId]
      );
      if (del.rowCount === 1) {
        await client.query('UPDATE community_groups SET member_count = GREATEST(0, member_count - 1) WHERE id = $1', [groupId]);
      }
      const cnt = await client.query('SELECT member_count FROM community_groups WHERE id = $1', [groupId]);
      return cnt.rows[0]?.member_count ?? 0;
    });
    res.json({ is_member: false, member_count: memberCount });
  } catch (err) {
    console.error('Error leaving group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
```

- [ ] **Step 4: Wire routes** (in `api.js`, after the `POST /groups` route)

```js
router.post('/groups/:id/membership', authenticateJWT, communityGroupsController.joinGroup);
router.delete('/groups/:id/membership', authenticateJWT, communityGroupsController.leaveGroup);
```

- [ ] **Step 5: Restart + test**

```bash
docker restart intellacc_backend && sleep 6
docker exec intellacc_backend npx jest test/community_groups.test.js --runInBand
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/controllers/communityGroupsController.js backend/src/routes/api.js backend/test/community_groups.test.js
git commit -m "feat(groups): join/leave membership with member_count"
```

---

### Task 4: Backend — search + soft-delete

**Files:**
- Modify: `backend/src/controllers/communityGroupsController.js`
- Modify: `backend/src/routes/api.js`
- Test: extend `backend/test/community_groups.test.js`

- [ ] **Step 1: Add the failing test** (append inside the `describe`)

```js
  test('search matches by name; soft-delete only by owner/admin and then 404s', async () => {
    const owner = await createUser('cgdel', 2);
    const other = await createUser('cgother', 2);
    cleanup.userIds.push(owner.id, other.id);
    const topicId = await firstTopicId();
    const created = await request(app).post('/api/groups')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Zebra Search Marker', description: '', topic_id: topicId });
    const { id, slug } = created.body.group;
    cleanup.groupIds.push(id);

    const search = await request(app).get('/api/groups/search').query({ q: 'Zebra Search' });
    expect(search.statusCode).toBe(200);
    expect(search.body.groups.some((g) => g.id === id)).toBe(true);

    const forbidden = await request(app).delete(`/api/groups/${id}`).set('Authorization', `Bearer ${other.token}`);
    expect(forbidden.statusCode).toBe(403);

    const removed = await request(app).delete(`/api/groups/${id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(removed.statusCode).toBe(200);

    const gone = await request(app).get(`/api/groups/${slug}`);
    expect(gone.statusCode).toBe(404);
  });
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `docker exec intellacc_backend npx jest test/community_groups.test.js --runInBand -t 'search matches'`

- [ ] **Step 3: Add controller methods** (append to `communityGroupsController.js`)

```js
exports.searchGroups = async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ groups: [] });
  const params = [`%${q}%`];
  let where = 'g.removed_at IS NULL AND g.name ILIKE $1';
  const topicId = parseInt(req.query.topic, 10);
  if (Number.isInteger(topicId)) { params.push(topicId); where += ` AND g.topic_id = $${params.length}`; }
  try {
    const result = await db.query(
      `SELECT g.id, g.slug, g.name, g.member_count FROM community_groups g
       WHERE ${where} ORDER BY g.member_count DESC LIMIT 5`,
      params
    );
    res.json({ groups: result.rows });
  } catch (err) {
    console.error('Error searching groups:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.deleteGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  const isAdmin = req.user?.role === 'admin';
  try {
    const g = await db.query('SELECT created_by FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    if (Number(g.rows[0].created_by) !== Number(viewerId) && !isAdmin) {
      return res.status(403).json({ message: 'Only the owner or an admin can remove this group' });
    }
    await db.query('UPDATE community_groups SET removed_at = NOW() WHERE id = $1', [groupId]);
    res.json({ removed: true });
  } catch (err) {
    console.error('Error removing group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
```

- [ ] **Step 4: Wire routes** — IMPORTANT: register `/groups/search` BEFORE `/groups/:slug` so "search" isn't captured as a slug.

In `api.js`, change the GET ordering so it reads:
```js
router.get('/groups', optionalAuth, communityGroupsController.listGroups);
router.get('/groups/search', communityGroupsController.searchGroups);
router.get('/groups/:slug', optionalAuth, communityGroupsController.getGroup);
```
And add after the membership routes:
```js
router.delete('/groups/:id', authenticateJWT, communityGroupsController.deleteGroup);
```

- [ ] **Step 5: Restart + run full file**

```bash
docker restart intellacc_backend && sleep 6
docker exec intellacc_backend npx jest test/community_groups.test.js --runInBand
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/controllers/communityGroupsController.js backend/src/routes/api.js backend/test/community_groups.test.js
git commit -m "feat(groups): search + owner/admin soft-delete"
```

---

### Task 5: Frontend — API wrappers

**Files:**
- Modify: `frontend-solid/src/services/api.js`

- [ ] **Step 1: Add a `groups` group inside the `api` object** (next to the `topics:` group)

```js
  groups: {
    list: ({ topic = null, sort = 'members', limit = 50 } = {}) => {
      const p = new URLSearchParams();
      if (topic != null) p.set('topic', topic);
      if (sort) p.set('sort', sort);
      if (limit) p.set('limit', limit);
      const qs = p.toString();
      return request(`/groups${qs ? `?${qs}` : ''}`);
    },
    search: (q, topic = null) => {
      const p = new URLSearchParams({ q });
      if (topic != null) p.set('topic', topic);
      return request(`/groups/search?${p.toString()}`);
    },
    get: (slug) => request(`/groups/${slug}`),
    create: (body) => request('/groups', { method: 'POST', body }),
    join: (id) => request(`/groups/${id}/membership`, { method: 'POST' }),
    leave: (id) => request(`/groups/${id}/membership`, { method: 'DELETE' })
  },
```

- [ ] **Step 2: Add named exports** (near the other `export const get… = …` lines)

```js
export const listGroups = (opts) => api.groups.list(opts);
export const searchGroups = (q, topic) => api.groups.search(q, topic);
export const getGroup = (slug) => api.groups.get(slug);
export const createGroup = (body) => api.groups.create(body);
export const joinGroup = (id) => api.groups.join(id);
export const leaveGroup = (id) => api.groups.leave(id);
```

(`request` already JSON-stringifies an object `body`, as `api.posts.create` does.)

- [ ] **Step 3: Verify syntax**

Run: `cd frontend-solid && node --check src/services/api.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add frontend-solid/src/services/api.js
git commit -m "feat(groups): api wrappers"
```

---

### Task 6: Frontend — routing, nav, browse page (layout B) + GroupCard

**Files:**
- Create: `frontend-solid/src/components/groups/GroupCard.jsx`
- Create: `frontend-solid/src/pages/GroupsPage.jsx`
- Modify: `frontend-solid/src/VanApp.jsx` (route `#groups` and `#group/:slug`)
- Modify: `frontend-solid/src/components/Layout.jsx` (nav link)
- Modify: `frontend-solid/src/styles.css` (append `.groups-*` styles)

- [ ] **Step 1: GroupCard component**

```jsx
// frontend-solid/src/components/groups/GroupCard.jsx
import { createSignal, Show } from 'solid-js';
import { joinGroup, leaveGroup } from '../../services/api';
import { isAuthenticated } from '../../services/auth';

export default function GroupCard(props) {
  const [member, setMember] = createSignal(!!props.group.is_member);
  const [count, setCount] = createSignal(Number(props.group.member_count) || 0);
  const [busy, setBusy] = createSignal(false);

  const open = () => { window.location.hash = `#group/${props.group.slug}`; };

  const toggle = async (e) => {
    e.stopPropagation();
    if (!isAuthenticated() || busy()) return;
    setBusy(true);
    try {
      const res = member() ? await leaveGroup(props.group.id) : await joinGroup(props.group.id);
      setMember(res.is_member);
      setCount(res.member_count);
    } catch { /* ignore; leave state unchanged */ }
    finally { setBusy(false); }
  };

  return (
    <div class="group-card" onClick={open}>
      <div class="group-card-top">
        <span class="group-card-name">{props.group.name}</span>
        <span class="group-chip">{props.group.topic_name}</span>
      </div>
      <Show when={props.group.description}>
        <p class="group-card-desc">{props.group.description}</p>
      </Show>
      <div class="group-card-meta">
        <span class="group-card-members">{count()} member{count() === 1 ? '' : 's'}</span>
        <Show when={isAuthenticated()}>
          <button type="button" class={`group-join ${member() ? 'joined' : ''}`} onClick={toggle} disabled={busy()}>
            {member() ? 'Joined ✓' : 'Join'}
          </button>
        </Show>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: GroupsPage (browse, layout B)**

```jsx
// frontend-solid/src/pages/GroupsPage.jsx
import { createSignal, createEffect, For, Show } from 'solid-js';
import api, { listGroups } from '../services/api'; // default `api` (for api.topics.list) + named listGroups
import { isAuthenticated } from '../services/auth';
import GroupCard from '../components/groups/GroupCard';
import CreateGroupForm from '../components/groups/CreateGroupForm';

export default function GroupsPage() {
  const [topics, setTopics] = createSignal([]);
  const [activeTopic, setActiveTopic] = createSignal(null); // null = All
  const [sort, setSort] = createSignal('members');
  const [groups, setGroups] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [showCreate, setShowCreate] = createSignal(false);

  api.topics.list().then((r) => setTopics(r?.topics || [])).catch(() => {});

  const load = async () => {
    setLoading(true); setError('');
    try {
      const r = await listGroups({ topic: activeTopic(), sort: sort() });
      setGroups(r?.groups || []);
    } catch (e) { setError(e?.message || 'Failed to load groups.'); }
    finally { setLoading(false); }
  };

  createEffect(() => { activeTopic(); sort(); load(); });

  const onCreated = (group) => { setShowCreate(false); window.location.hash = `#group/${group.slug}`; };

  return (
    <section class="groups-page">
      <div class="groups-header">
        <h1>Groups</h1>
        <Show when={isAuthenticated()}>
          <button type="button" class="button primary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate() ? 'Close' : '+ New group'}
          </button>
        </Show>
      </div>

      <Show when={showCreate()}>
        <CreateGroupForm topics={topics()} onCreated={onCreated} />
      </Show>

      <div class="groups-controls">
        <div class="groups-tabs">
          <button type="button" class={`groups-tab ${activeTopic() === null ? 'on' : ''}`} onClick={() => setActiveTopic(null)}>All</button>
          <For each={topics()}>
            {(t) => (
              <button type="button" class={`groups-tab ${activeTopic() === t.id ? 'on' : ''}`} onClick={() => setActiveTopic(t.id)}>{t.name}</button>
            )}
          </For>
        </div>
        <select class="groups-sort" value={sort()} onChange={(e) => setSort(e.currentTarget.value)}>
          <option value="members">Most members</option>
          <option value="recent">Most recent</option>
        </select>
      </div>

      <Show when={error()}><p class="error-message">{error()}</p></Show>
      <Show when={loading()}><p>Loading groups…</p></Show>
      <Show when={!loading() && groups().length === 0}>
        <p class="groups-empty">No groups here yet — start one.</p>
      </Show>
      <div class="groups-list">
        <For each={groups()}>{(g) => <GroupCard group={g} />}</For>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Route in VanApp** — add imports and route branches.

In `frontend-solid/src/VanApp.jsx`, add imports near the other page imports:
```jsx
import GroupsPage from './pages/GroupsPage';
import GroupPage from './pages/GroupPage';
```
Add a slug accessor near `const profilePageId = () => routeParam();`:
```jsx
  const groupSlug = () => routeParam();
```
Add route branches alongside the others (e.g. after the `network` branch):
```jsx
    if (page() === 'groups') {
      return <GroupsPage />;
    }
    if (page() === 'group') {
      return <GroupPage slug={groupSlug} />;
    }
```
(`GroupPage` is created in Task 8; until then this import will fail to resolve — so do Task 8 before running the dev server, or temporarily comment the `group` branch. The recommended order is 6 → 7 → 8.)

- [ ] **Step 4: Nav link in Layout** — add after the Network item (`backend`-style `.sidebar-item`):

```jsx
        <div class="sidebar-item">
          <a href="#groups">Groups</a>
        </div>
```

- [ ] **Step 5: Styles** — append to `frontend-solid/src/styles.css`:

```css
.groups-page { display: grid; gap: 1rem; }
.groups-header { display: flex; align-items: center; justify-content: space-between; }
.groups-controls { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.groups-tabs { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.groups-tab { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius); padding: 0.3rem 0.6rem; font: inherit; font-size: 0.85rem; cursor: pointer; }
.groups-tab.on { background: var(--primary-color); color: #fff; border-color: var(--primary-color); }
.groups-sort { border: 1px solid var(--border-color); border-radius: var(--border-radius); padding: 0.3rem 0.5rem; font: inherit; background: var(--card-bg); }
.groups-list { display: grid; gap: 0.6rem; }
.groups-empty { color: var(--secondary-text); }
.group-card { border: 1px solid var(--border-color); border-radius: var(--border-radius); background: var(--card-bg); padding: 0.7rem 0.85rem; cursor: pointer; }
.group-card-top { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
.group-card-name { font-weight: 700; }
.group-chip { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; color: var(--primary-color); border: 1px solid var(--primary-color); border-radius: var(--border-radius); padding: 0.05rem 0.4rem; white-space: nowrap; }
.group-card-desc { font-size: 0.85rem; color: var(--secondary-text); margin: 0.35rem 0; }
.group-card-meta { display: flex; align-items: center; justify-content: space-between; }
.group-card-members { font-size: 0.8rem; color: var(--secondary-text); }
.group-join { border: 1px solid var(--primary-color); background: var(--primary-color); color: #fff; border-radius: var(--border-radius); font: inherit; font-size: 0.78rem; font-weight: 700; padding: 0.25rem 0.7rem; cursor: pointer; }
.group-join.joined { background: var(--card-bg); color: var(--primary-color); }
```

- [ ] **Step 6: Commit** (after Task 8 compiles cleanly, or comment the `group` branch to verify now)

```bash
git add frontend-solid/src/components/groups/GroupCard.jsx frontend-solid/src/pages/GroupsPage.jsx frontend-solid/src/VanApp.jsx frontend-solid/src/components/Layout.jsx frontend-solid/src/styles.css
git commit -m "feat(groups): browse page (layout B), GroupCard, route + nav"
```

---

### Task 7: Frontend — CreateGroupForm (tier-gated via 403 + soft dup warning)

**Files:**
- Create: `frontend-solid/src/components/groups/CreateGroupForm.jsx`
- Modify: `frontend-solid/src/styles.css` (append `.group-create-*` styles)

**Context:** Verification tier isn't reliably available client-side, so the backend `403` is the gate. On a 403, show the verify notice; otherwise show validation errors inline. The soft duplicate warning calls `searchGroups` on name blur.

- [ ] **Step 1: Component**

```jsx
// frontend-solid/src/components/groups/CreateGroupForm.jsx
import { createSignal, For, Show } from 'solid-js';
import { createGroup, searchGroups } from '../../services/api';

export default function CreateGroupForm(props) {
  const [name, setName] = createSignal('');
  const [topicId, setTopicId] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [dupes, setDupes] = createSignal([]);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');
  const [needsVerify, setNeedsVerify] = createSignal(false);

  const checkDupes = async () => {
    const q = name().trim();
    if (q.length < 2) { setDupes([]); return; }
    try { const r = await searchGroups(q, topicId() || null); setDupes(r?.groups || []); }
    catch { setDupes([]); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setNeedsVerify(false);
    if (name().trim().length < 3) { setError('Name must be at least 3 characters.'); return; }
    if (!topicId()) { setError('Please choose a topic.'); return; }
    setSubmitting(true);
    try {
      const r = await createGroup({ name: name().trim(), description: description().trim(), topic_id: Number(topicId()) });
      props.onCreated?.(r.group);
    } catch (err) {
      if (err?.status === 403) setNeedsVerify(true);
      else setError(err?.message || 'Could not create group.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form class="group-create" onSubmit={submit}>
      <Show when={needsVerify()}>
        <div class="group-create-gate">
          Creating a group needs a verified account (phone or payment).{' '}
          <a href="#settings">Verify your account</a> to create one.
        </div>
      </Show>

      <div class="group-create-field">
        <label>Name</label>
        <input class="group-create-input" value={name()} maxlength="80"
          onInput={(e) => setName(e.currentTarget.value)} onBlur={checkDupes} placeholder="e.g. BTC $200k in 2026?" />
        <Show when={dupes().length > 0}>
          <div class="group-create-warn">⚠ Similar group{dupes().length > 1 ? 's' : ''} exist:
            <For each={dupes()}>{(d) => <span> “{d.name}”</span>}</For>. Consider joining instead.
          </div>
        </Show>
      </div>

      <div class="group-create-field">
        <label>Topic</label>
        <select class="group-create-input" value={topicId()} onChange={(e) => setTopicId(e.currentTarget.value)}>
          <option value="">-- choose a topic --</option>
          <For each={props.topics || []}>{(t) => <option value={t.id}>{t.name}</option>}</For>
        </select>
      </div>

      <div class="group-create-field">
        <label>Description</label>
        <textarea class="group-create-input" rows="3" maxlength="500" value={description()}
          onInput={(e) => setDescription(e.currentTarget.value)} placeholder="A sentence or two on the theme." />
      </div>

      <Show when={error()}><p class="error-message">{error()}</p></Show>
      <div class="group-create-actions">
        <button type="submit" class="button primary" disabled={submitting()}>
          {submitting() ? 'Creating…' : 'Create group'}
        </button>
        <span class="group-card-members">You’ll be the owner and first member.</span>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Styles** — append to `styles.css`:

```css
.group-create { border: 1px solid var(--border-color); border-radius: var(--border-radius); background: var(--card-bg); padding: 0.9rem; display: grid; gap: 0.7rem; }
.group-create-field { display: grid; gap: 0.25rem; }
.group-create-field label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.group-create-input { width: 100%; box-sizing: border-box; border: 1px solid var(--border-color); border-radius: var(--border-radius); padding: 0.45rem 0.5rem; font: inherit; background: #fff; }
.group-create-warn { font-size: 0.78rem; color: #b06b00; }
.group-create-gate { border: 1px solid var(--border-color); border-left: 4px solid var(--primary-color); background: var(--hover-bg); padding: 0.55rem 0.7rem; font-size: 0.85rem; }
.group-create-actions { display: flex; align-items: center; gap: 0.7rem; }
```

- [ ] **Step 3: Commit**

```bash
git add frontend-solid/src/components/groups/CreateGroupForm.jsx frontend-solid/src/styles.css
git commit -m "feat(groups): CreateGroupForm (tier-gated + dup warning)"
```

---

### Task 8: Frontend — GroupPage (header + tab scaffold)

**Files:**
- Create: `frontend-solid/src/pages/GroupPage.jsx`
- Modify: `frontend-solid/src/styles.css` (append `.group-page-*` styles)

- [ ] **Step 1: Component**

```jsx
// frontend-solid/src/pages/GroupPage.jsx
import { createSignal, createEffect, Show } from 'solid-js';
import { getGroup, joinGroup, leaveGroup } from '../services/api';
import { isAuthenticated } from '../services/auth';

export default function GroupPage(props) {
  const slug = () => (typeof props.slug === 'function' ? props.slug() : props.slug);
  const [group, setGroup] = createSignal(null);
  const [tab, setTab] = createSignal('feed');
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  createEffect(async () => {
    const s = slug();
    if (!s) return;
    setLoading(true); setError('');
    try { const r = await getGroup(s); setGroup(r.group); }
    catch (e) { setError(e?.status === 404 ? 'Group not found.' : (e?.message || 'Failed to load group.')); setGroup(null); }
    finally { setLoading(false); }
  });

  const toggle = async () => {
    const g = group();
    if (!g || !isAuthenticated() || busy()) return;
    setBusy(true);
    try {
      const res = g.is_member ? await leaveGroup(g.id) : await joinGroup(g.id);
      setGroup({ ...g, is_member: res.is_member, member_count: res.member_count });
    } catch { /* leave unchanged */ } finally { setBusy(false); }
  };

  return (
    <section class="group-page">
      <a class="group-back" href="#groups">‹ Groups</a>
      <Show when={loading()}><p>Loading…</p></Show>
      <Show when={error()}><p class="error-message">{error()}</p></Show>
      <Show when={group()}>
        <div class="group-detail-card">
          <div class="group-detail-head">
            <div class="group-detail-titlerow">
              <h1 class="group-detail-name">{group().name}</h1>
              <span class="group-chip">{group().topic_name}</span>
            </div>
            <Show when={group().description}><p class="group-detail-desc">{group().description}</p></Show>
            <div class="group-detail-actions">
              <span class="group-card-members">{group().member_count} member{group().member_count === 1 ? '' : 's'}</span>
              <Show when={isAuthenticated()}>
                <button type="button" class={`group-join ${group().is_member ? 'joined' : ''}`} onClick={toggle} disabled={busy()}>
                  {group().is_member ? 'Joined ✓' : 'Join'}
                </button>
              </Show>
            </div>
          </div>
          <div class="group-tabs">
            <button type="button" class={`group-tab ${tab() === 'feed' ? 'on' : ''}`} onClick={() => setTab('feed')}>Feed</button>
            <button type="button" class="group-tab disabled" disabled>Chat <span class="group-tab-soon">soon</span></button>
            <button type="button" class="group-tab disabled" disabled>Markets <span class="group-tab-soon">later</span></button>
          </div>
          <div class="group-tab-body">
            <p class="groups-empty">No posts yet — be the first to post in this group.</p>
          </div>
        </div>
      </Show>
    </section>
  );
}
```

- [ ] **Step 2: Styles** — append to `styles.css`:

```css
.group-page { display: grid; gap: 0.6rem; }
.group-back { font-size: 0.78rem; font-weight: 700; text-transform: uppercase; color: var(--primary-color); }
.group-detail-card { border: 1px solid var(--border-color); border-radius: var(--border-radius); background: var(--card-bg); }
.group-detail-head { padding: 0.9rem; border-bottom: 1px solid var(--border-color); }
.group-detail-titlerow { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.6rem; }
.group-detail-name { margin: 0; font-size: 1.4rem; }
.group-detail-desc { color: var(--secondary-text); margin: 0.5rem 0; }
.group-detail-actions { display: flex; align-items: center; gap: 0.8rem; }
.group-tabs { display: flex; border-bottom: 1px solid var(--border-color); }
.group-tab { flex: 1; border: none; border-right: 1px solid var(--border-color); background: var(--card-bg); font: inherit; font-weight: 700; text-transform: uppercase; font-size: 0.8rem; padding: 0.5rem; cursor: pointer; }
.group-tab:last-child { border-right: none; }
.group-tab.on { background: var(--primary-color); color: #fff; }
.group-tab.disabled { color: var(--pending-color); cursor: default; }
.group-tab-soon { font-size: 0.6rem; }
.group-tab-body { padding: 1.4rem 0.9rem; text-align: center; }
```

- [ ] **Step 3: Verify the whole frontend compiles on solid-local**

```bash
docker compose -p solid-local -f docker-compose.solid-local.yml up -d
sleep 9 && docker logs --tail 20 intellacc_frontend_solid_local 2>&1 | grep -iE "ready|error"
```
Expected: `VITE … ready`, no compile error. Then open `http://localhost:4174/#groups` and confirm the browse page, create form (as a tier-≥2 user), and a group page render.

- [ ] **Step 4: Commit**

```bash
git add frontend-solid/src/pages/GroupPage.jsx frontend-solid/src/styles.css
git commit -m "feat(groups): group page (header + tab scaffold)"
```

---

### Task 9: Playwright smoke + finalize

**Files:**
- Create: `tests/e2e/community-groups.spec.js`

- [ ] **Step 1: Write the smoke** (tier-≥2 fixture creates a group; a second user joins)

```js
// tests/e2e/community-groups.spec.js
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('create a group (tier>=2), it appears in browse, and a user can join', async ({ page, browser }) => {
  const owner = await createUser('cguiowner');
  created.push(owner);
  dbQuery(`UPDATE users SET verification_tier = 2 WHERE id = ${owner.id}`);
  // assign topics so onboarding gate doesn't intercept
  const topics = (await apiFetch('/api/topics')).body.topics;
  await apiFetch('/api/users/me/topics', { method: 'PUT', token: owner.token, body: JSON.stringify({ topicIds: topics.slice(0, 3).map((t) => t.id) }) });

  await page.addInitScript((t) => localStorage.setItem('token', t), owner.token);
  await page.goto(`${SOLID_URL}/#groups`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: '+ New group' }).click();
  const unique = `Smoke Group ${Date.now()}`;
  await page.locator('.group-create-input').first().fill(unique);
  await page.locator('select.group-create-input').selectOption(String(topics[0].id));
  await page.getByRole('button', { name: 'Create group' }).click();

  // navigated to the new group page: owner is member, 1 member, Feed active
  await expect(page.locator('.group-detail-name')).toHaveText(unique, { timeout: 15000 });
  await expect(page.locator('.group-detail-actions')).toContainText('1 member');
  await expect(page.locator('.group-tab.on')).toHaveText('Feed');

  // exercise the membership toggle on the page: leave -> 0, then re-join -> 1
  const memberBtn = page.locator('.group-detail-actions .group-join');
  await expect(memberBtn).toHaveText('Joined ✓');
  await memberBtn.click();
  await expect(memberBtn).toHaveText('Join', { timeout: 10000 });
  await expect(page.locator('.group-detail-actions')).toContainText('0 members');
  await memberBtn.click();
  await expect(memberBtn).toHaveText('Joined ✓', { timeout: 10000 });
  await expect(page.locator('.group-detail-actions')).toContainText('1 member');
});
```

- [ ] **Step 2: Run it** (solid-local up from Task 8)

Run: `KEEP_E2E_USERS=0 npx playwright test tests/e2e/community-groups.spec.js --reporter=line`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/community-groups.spec.js
git commit -m "test(groups): create+browse smoke"
```

- [ ] **Step 4: Finalize**

```bash
# full new backend test once more
docker exec intellacc_backend npx jest test/community_groups.test.js --runInBand
# tear down dev stack
docker compose -p solid-local -f docker-compose.solid-local.yml down
# merge + deploy
git checkout master && git merge --no-ff <branch> -m "Merge: Community Groups core (sub-project A)"
git push origin master
docker restart intellacc_backend          # serve new endpoints
docker restart intellacc_frontend_solid   # rebuild prod frontend (~2 min)
```
Then `gh run watch <run-id> --exit-status` until CI is green on all jobs.

---

## Notes for the implementer

- **Route ordering matters:** `/groups/search` must be registered before `/groups/:slug` or "search" is treated as a slug. (Task 4 fixes the order.)
- **`optionalAuth`:** browse/detail should work logged-out (with `is_member: false`). Use the existing optional-auth middleware if present; otherwise `authenticateJWT` is acceptable for v1 (logged-out users would then need to sign in to browse — confirm with the existing `GET /posts` pattern, which is public).
- **Build order 6 → 7 → 8:** `VanApp` imports `GroupPage` (Task 8); don't run the dev server between Task 6 and Task 8, or temporarily comment the `#group` branch.
- **member_count** is denormalized and only changed inside the same transaction as the membership row change; join/leave are idempotent.
- **Tier gate** is enforced server-side (`requirePhoneVerified` = `requireTier(2)`); the form surfaces it via the 403 path.
- **Backend restart** after controller/route edits before verifying against the running server.
