# Community Groups — Feed (Sub-project B) Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Members post into a group; the group page's Feed tab shows the group's posts.

**Architecture:** Nullable `posts.community_group_id`; `createPost` accepts it (member-gated); `GET /groups/:slug/posts` lists a group's posts in the `PostItem` shape; the Feed tab renders a composer (members) + `PostItem` list.

**Tech Stack:** Express + PostgreSQL; SolidJS van skin; Jest/supertest; Playwright.

**Spec:** `docs/superpowers/specs/2026-06-17-community-groups-feed-design.md`

**Conventions:** backend tests `docker exec intellacc_backend npx jest test/<f> --runInBand`; restart `intellacc_backend` after controller/route edits before hitting the live server; frontend dev `docker compose -p solid-local -f docker-compose.solid-local.yml up -d` (ALWAYS `-p solid-local`), port 4174. Branch off master; merge `--no-ff`.

---

### Task 1: Migration — `posts.community_group_id`

**Files:** Create `backend/migrations/20260618_posts_community_group.sql`

- [ ] **Step 1:** write:
```sql
-- Sub-project B: a post may belong to one community group (NULL = global post).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS community_group_id INT REFERENCES community_groups(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_posts_community_group ON posts (community_group_id, created_at DESC) WHERE community_group_id IS NOT NULL;
```
- [ ] **Step 2:** apply: `docker exec intellacc_backend sh -lc 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20260618_posts_community_group.sql'` (expect ALTER TABLE / CREATE INDEX).
- [ ] **Step 3:** verify: `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "\d posts" | grep community_group_id`.
- [ ] **Step 4:** commit `feat(groups): posts.community_group_id column`.

---

### Task 2: Backend — post into a group + group feed endpoint

**Files:** Modify `backend/src/controllers/postController.js`, `backend/src/controllers/communityGroupsController.js`, `backend/src/routes/api.js`; Test `backend/test/community_group_feed.test.js`.

- [ ] **Step 1: failing test** `backend/test/community_group_feed.test.js`:
```js
const request = require('supertest');
const { app } = require('../src/index');
const db = require('../src/db');
jest.setTimeout(30000);

const mkUser = async (label, tier = 0) => {
  const u = Date.now() + Math.floor(Math.random() * 100000);
  const email = `${label}_${u}@example.com`;
  await request(app).post('/api/users/register').send({ username: `${label}_${u}`, email, password: 'testpass123' });
  const login = await request(app).post('/api/login').send({ email, password: 'testpass123' });
  const row = await db.query('SELECT id FROM users WHERE email=$1', [email]);
  await db.query('UPDATE users SET verification_tier=$1, email_verified_at=NOW() WHERE id=$2', [tier, row.rows[0].id]);
  return { id: row.rows[0].id, token: login.body.token };
};
const firstTopic = async () => (await db.query('SELECT id FROM topics ORDER BY id LIMIT 1')).rows[0].id;

describe('Community group feed', () => {
  const cleanup = { userIds: [], groupIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('member posts into a group; non-member 403; feed lists it', async () => {
    const owner = await mkUser('gfowner', 2);
    const stranger = await mkUser('gfstranger', 2);
    cleanup.userIds.push(owner.id, stranger.id);
    const topicId = await firstTopic();
    const g = await request(app).post('/api/groups').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Feed group test', description: '', topic_id: topicId });
    const { id, slug } = g.body.group;
    cleanup.groupIds.push(id);

    const posted = await request(app).post('/api/posts').set('Authorization', `Bearer ${owner.token}`)
      .send({ content: 'first group post', community_group_id: id });
    expect(posted.statusCode).toBe(201);
    expect(posted.body.community_group_id).toBe(id);

    const denied = await request(app).post('/api/posts').set('Authorization', `Bearer ${stranger.token}`)
      .send({ content: 'intruder', community_group_id: id });
    expect(denied.statusCode).toBe(403);

    const rejected = await request(app).post('/api/posts').set('Authorization', `Bearer ${owner.token}`)
      .send({ content: 'bad', community_group_id: id, parent_id: posted.body.id });
    expect(rejected.statusCode).toBe(400);

    const feed = await request(app).get(`/api/groups/${slug}/posts`).set('Authorization', `Bearer ${owner.token}`);
    expect(feed.statusCode).toBe(200);
    const row = feed.body.posts.find((p) => p.id === posted.body.id);
    expect(row).toBeTruthy();
    expect(row.username).toBeTruthy();
    expect(typeof row.like_count).toBe('number');
    expect('liked_by_user' in row).toBe(true);
  });
});
```
- [ ] **Step 2:** run, expect FAIL.

- [ ] **Step 3: `createPost` group support** (`postController.js`).
  - Add `community_group_id` to the destructure:
    `let { content, image_url, image_attachment_id, parent_id, repost_id, community_group_id } = req.body;`
  - Just BEFORE the `db.query('INSERT INTO posts …')` call, add:
```js
    let communityGroupId = null;
    if (community_group_id !== undefined && community_group_id !== null) {
      if (parent_id) return res.status(400).json({ message: 'Cannot post a comment into a group' });
      const gid = parseInt(community_group_id, 10);
      if (!Number.isInteger(gid)) return res.status(400).json({ message: 'Invalid group id' });
      const grp = await db.query('SELECT id FROM community_groups WHERE id = $1 AND removed_at IS NULL', [gid]);
      if (grp.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
      const mem = await db.query('SELECT 1 FROM community_group_members WHERE group_id = $1 AND user_id = $2', [gid, userId]);
      if (mem.rows.length === 0) return res.status(403).json({ message: 'Join the group to post in it' });
      communityGroupId = gid;
    }
```
  - Change the INSERT to include the column + value (add `community_group_id` as `$12`, shifting `created_at, updated_at`):
```js
      'INSERT INTO posts (user_id, content, image_url, image_attachment_id, parent_id, depth, is_comment, is_bot, link_url, link_metadata_id, repost_id, community_group_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW()) RETURNING *',
      [userId, content || '', image_url || null, image_attachment_id || null, parentId, depth, isComment, isBot, linkUrl || null, linkMetadataId || null, repost_id || null, communityGroupId]
```
  (`RETURNING *` already includes `community_group_id`, so the response carries it.)

- [ ] **Step 4: `getGroupPosts`** — append to `communityGroupsController.js`:
```js
exports.getGroupPosts = async (req, res) => {
  const viewerId = getViewerId(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE slug = $1 AND removed_at IS NULL', [req.params.slug]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const groupId = g.rows[0].id;
    const params = [groupId, viewerId];
    let cursor = '';
    if (req.query.before) {
      params.push(req.query.before, parseInt(req.query.beforeId, 10) || 0);
      cursor = ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(limit + 1);
    const result = await db.query(
      `SELECT p.id, p.user_id, u.username, u.avatar_url, p.content, p.image_url, p.created_at,
              p.like_count, p.comment_count,
              CASE WHEN EXISTS (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $2) THEN true ELSE false END AS liked_by_user,
              (SELECT COUNT(*)::int FROM posts rpc WHERE rpc.repost_id = p.id) AS repost_count,
              CASE WHEN EXISTS (SELECT 1 FROM posts rpu WHERE rpu.repost_id = p.id AND rpu.user_id = $2) THEN true ELSE false END AS reposted_by_user
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.community_group_id = $1${cursor}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${params.length}`,
      params
    );
    const rows = result.rows;
    const hasMore = rows.length > limit;
    res.json({ posts: hasMore ? rows.slice(0, limit) : rows, hasMore });
  } catch (err) {
    console.error('Error listing group posts:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
```
- [ ] **Step 5: route** — in `api.js`, add (after the `/groups/:slug` GET; placing `/groups/:slug/posts` is unambiguous since it has an extra segment):
```js
router.get('/groups/:slug/posts', optionalAuth, communityGroupsController.getGroupPosts);
```
- [ ] **Step 6:** `docker restart intellacc_backend && sleep 6`; run the test (expect PASS).
- [ ] **Step 7:** commit `feat(groups): post into a group + group feed endpoint`.

---

### Task 3: Frontend — composer + Feed tab

**Files:** Modify `frontend-solid/src/services/api.js`, `frontend-solid/src/components/posts/CreatePostForm.jsx`, `frontend-solid/src/pages/GroupPage.jsx`.

- [ ] **Step 1: api wrappers** — in the `posts` group add `postToGroup`, and add a `groups.posts` reader. Concretely add to the `groups:` object:
```js
    posts: (slug, { limit = 30, before = null, beforeId = null } = {}) => {
      const p = new URLSearchParams();
      if (limit) p.set('limit', limit);
      if (before) { p.set('before', before); p.set('beforeId', beforeId ?? ''); }
      const qs = p.toString();
      return request(`/groups/${slug}/posts${qs ? `?${qs}` : ''}`);
    },
```
and in the `posts:` object add:
```js
    createInGroup: (groupId, content, image_attachment_id = null) =>
      request('/posts', { method: 'POST', body: { content, image_attachment_id, community_group_id: groupId } }),
```
and named exports:
```js
export const getGroupPosts = (slug, opts) => api.groups.posts(slug, opts);
export const postToGroup = (groupId, content, imageAttachmentId) => api.posts.createInGroup(groupId, content, imageAttachmentId);
```
- [ ] **Step 2: `CreatePostForm` groupId prop** — where it currently calls `createPost(text, imageAttachmentId, null)`, branch:
```js
      const post = props.groupId
        ? await postToGroup(props.groupId, text, imageAttachmentId)
        : await createPost(text, imageAttachmentId, null);
```
Add `postToGroup` to the import from `../../services/api`.
- [ ] **Step 3: `GroupPage` Feed tab** — add posts state + loader and render under the Feed tab. Add imports:
```jsx
import { For } from 'solid-js';
import PostItem from '../components/posts/PostItem';
import CreatePostForm from '../components/posts/CreatePostForm';
import { getGroupPosts } from '../services/api';
```
Add signals + loader inside the component:
```jsx
  const [posts, setPosts] = createSignal([]);
  const [feedLoaded, setFeedLoaded] = createSignal(false);
  const loadFeed = async () => {
    const g = group(); if (!g) return;
    try { const r = await getGroupPosts(g.slug, { limit: 30 }); setPosts(r.posts || []); setFeedLoaded(true); }
    catch { setPosts([]); setFeedLoaded(true); }
  };
  createEffect(() => { if (group() && tab() === 'feed' && !feedLoaded()) loadFeed(); });
  const onPosted = (post) => setPosts((cur) => [post, ...cur]);
```
Replace the `group-tab-body` placeholder with:
```jsx
          <div class="group-tab-body" classList={{ 'group-feed-body': tab() === 'feed' }}>
            <Show when={tab() === 'feed'} fallback={<p class="groups-empty">Coming soon.</p>}>
              <Show when={group().is_member} fallback={<p class="groups-empty">Join this group to post.</p>}>
                <CreatePostForm groupId={group().id} onCreated={onPosted} />
              </Show>
              <Show when={feedLoaded() && posts().length === 0}>
                <p class="groups-empty">No posts yet — be the first to post in this group.</p>
              </Show>
              <div class="posts-list">
                <For each={posts()}>{(p) => <PostItem post={p} onPostUpdate={() => {}} onPostDelete={() => setPosts((c) => c.filter((x) => x.id !== p.id))} />}</For>
              </div>
            </Show>
          </div>
```
(Keep the existing `group-tab-body` text-align center only for non-feed; the `group-feed-body` class can left-align — add `.group-feed-body { text-align: left; padding: 0.9rem; }` to styles.css.)
- [ ] **Step 4:** bring up solid-local (`-p solid-local`), confirm Vite compiles (no error), open a group as a member and post.
- [ ] **Step 5:** commit `feat(groups): group Feed tab — composer + post list`.

---

### Task 4: Smoke + finalize

- [ ] **Step 1:** extend `tests/e2e/community-groups.spec.js` (or new `community-group-feed.spec.js`): as a tier≥2 member, open a created group, on the Feed tab type a post + submit, assert it appears (`PostItem` with the text). Run with `KEEP_E2E_USERS=0 npx playwright test … --reporter=line`.
- [ ] **Step 2:** `docker exec intellacc_backend npx jest test/community_group_feed.test.js --runInBand` green; tear down solid-local.
- [ ] **Step 3:** merge `--no-ff`, push, restart backend + frontend, `gh run watch` until CI green.

## Notes
- `community_group_id` on a post is independent of `parent_id` (group posts are top-level; combining is 400).
- `getGroupPosts` returns the subset of fields `PostItem` needs; missing reposted_post/ai fields degrade gracefully via `<Show>`.
- Restart backend before verifying endpoints against the live server.
