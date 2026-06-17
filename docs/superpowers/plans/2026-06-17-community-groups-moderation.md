# Community Groups — Moderation (Sub-project E) Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Report a group; owner/admin remove a post or kick a member; a Members tab.

**Spec:** `docs/superpowers/specs/2026-06-17-community-groups-moderation-design.md`

**Conventions:** backend tests `docker exec intellacc_backend npx jest …`; restart backend after edits; frontend `docker compose -p solid-local …` (ALWAYS `-p solid-local`), 4174. Reuses `assertCanManage` (owner/admin) + `getViewerId` already in `communityGroupsController.js`, `db.executeWithTransaction`, and the existing `moderation_reports` table.

---

### Task 1: Backend — members list, report, remove post, kick member
**Files:** `communityGroupsController.js`, `routes/api.js`; Test `backend/test/community_group_moderation.test.js`.

- [ ] **Test:**
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

describe('Community group moderation', () => {
  const cleanup = { userIds: [], groupIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) {
      await db.query('DELETE FROM moderation_reports WHERE reported_content_type = $1 AND reported_content_id = ANY($2::int[])', ['group', cleanup.groupIds]);
      await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    }
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('report group; remove post; kick member; members list', async () => {
    const owner = await mkUser('gmodowner', 2);
    const member = await mkUser('gmodmember', 2);
    cleanup.userIds.push(owner.id, member.id);
    const topicId = await firstTopic();
    const g = await request(app).post('/api/groups').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Mod group test', description: '', topic_id: topicId });
    const { id, slug } = g.body.group;
    cleanup.groupIds.push(id);
    await request(app).post(`/api/groups/${id}/membership`).set('Authorization', `Bearer ${member.token}`); // member joins

    // report: owner can't report own; member can
    const ownReport = await request(app).post(`/api/groups/${id}/report`).set('Authorization', `Bearer ${owner.token}`).send({ reason: 'x' });
    expect(ownReport.statusCode).toBe(400);
    const report = await request(app).post(`/api/groups/${id}/report`).set('Authorization', `Bearer ${member.token}`).send({ reason: 'spam' });
    expect(report.statusCode).toBe(201);
    const rep = await db.query("SELECT * FROM moderation_reports WHERE reported_content_type='group' AND reported_content_id=$1", [id]);
    expect(rep.rows.length).toBe(1);

    // member posts; owner removes it; non-owner can't
    const post = await request(app).post('/api/posts').set('Authorization', `Bearer ${member.token}`).send({ content: 'member post', community_group_id: id });
    const postId = post.body.id;
    const cantRemove = await request(app).delete(`/api/groups/${id}/posts/${postId}`).set('Authorization', `Bearer ${member.token}`);
    expect(cantRemove.statusCode).toBe(403);
    const removed = await request(app).delete(`/api/groups/${id}/posts/${postId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(removed.statusCode).toBe(200);
    const feed = await request(app).get(`/api/groups/${slug}/posts`);
    expect(feed.body.posts.find((p) => p.id === postId)).toBeFalsy();

    // members list (owner first), kick member, can't kick owner
    const members1 = await request(app).get(`/api/groups/${slug}/members`);
    expect(members1.body.members[0].role).toBe('owner');
    expect(members1.body.members.some((m) => m.user_id === member.id)).toBe(true);

    const cantKickOwner = await request(app).delete(`/api/groups/${id}/members/${owner.id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(cantKickOwner.statusCode).toBe(400);
    const kick = await request(app).delete(`/api/groups/${id}/members/${member.id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(kick.statusCode).toBe(200);
    expect(kick.body.member_count).toBe(1);
    const members2 = await request(app).get(`/api/groups/${slug}/members`);
    expect(members2.body.members.some((m) => m.user_id === member.id)).toBe(false);
  });
});
```
Run → expect FAIL.

- [ ] **Controller** — append to `communityGroupsController.js`:
```js
exports.listGroupMembers = async (req, res) => {
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE slug = $1 AND removed_at IS NULL', [req.params.slug]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const result = await db.query(
      `SELECT m.user_id, u.username, m.role
       FROM community_group_members m JOIN users u ON u.id = m.user_id
       WHERE m.group_id = $1 ORDER BY (m.role = 'owner') DESC, m.joined_at ASC`,
      [g.rows[0].id]
    );
    res.json({ members: result.rows });
  } catch (err) {
    console.error('Error listing members:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.reportGroup = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  const reason = String(req.body?.reason || '').trim();
  const details = String(req.body?.details || '').trim() || null;
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  if (!reason) return res.status(400).json({ message: 'Report reason is required' });
  try {
    const g = await db.query('SELECT created_by FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    if (Number(g.rows[0].created_by) === Number(viewerId)) return res.status(400).json({ message: "You can't report your own group" });
    await db.query(
      `INSERT INTO moderation_reports (reporter_id, reported_user_id, reported_content_type, reported_content_id, report_reason, details)
       VALUES ($1, $2, 'group', $3, $4, $5)`,
      [viewerId, g.rows[0].created_by, groupId, reason, details]
    );
    res.status(201).json({ reported: true });
  } catch (err) {
    console.error('Error reporting group:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.removeGroupPost = async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const postId = parseInt(req.params.postId, 10);
  if (!Number.isInteger(groupId) || !Number.isInteger(postId)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const can = await assertCanManage(groupId, req);
    if (can.error) return res.status(can.error).json({ message: can.message });
    const p = await db.query('SELECT id, community_group_id FROM posts WHERE id = $1', [postId]);
    if (p.rows.length === 0) return res.status(404).json({ message: 'Post not found' });
    if (Number(p.rows[0].community_group_id) !== groupId) return res.status(400).json({ message: 'Post is not in this group' });
    await db.query('DELETE FROM posts WHERE id = $1', [postId]);
    res.json({ removed: true });
  } catch (err) {
    console.error('Error removing group post:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.removeMember = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(groupId) || !Number.isInteger(userId)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const g = await db.query('SELECT created_by FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    if (Number(g.rows[0].created_by) !== Number(viewerId) && req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Only the owner or an admin can remove members' });
    }
    if (Number(g.rows[0].created_by) === Number(userId)) return res.status(400).json({ message: "You can't remove the owner" });
    const memberCount = await db.executeWithTransaction(async (client) => {
      const del = await client.query('DELETE FROM community_group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
      if (del.rowCount === 1) {
        await client.query('UPDATE community_groups SET member_count = GREATEST(0, member_count - 1) WHERE id = $1', [groupId]);
      }
      const c = await client.query('SELECT member_count FROM community_groups WHERE id = $1', [groupId]);
      return c.rows[0]?.member_count ?? 0;
    });
    res.json({ removed: true, member_count: memberCount });
  } catch (err) {
    console.error('Error removing member:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
```
- [ ] **Routes** (`api.js`, after the markets routes):
```js
router.get('/groups/:slug/members', optionalAuth, communityGroupsController.listGroupMembers);
router.post('/groups/:id/report', authenticateJWT, communityGroupsController.reportGroup);
router.delete('/groups/:id/posts/:postId', authenticateJWT, communityGroupsController.removeGroupPost);
router.delete('/groups/:id/members/:userId', authenticateJWT, communityGroupsController.removeMember);
```
- [ ] Restart backend; run test (expect PASS). Commit `feat(groups): moderation endpoints (report, remove post, kick member, members)`.

---

### Task 2: Frontend — Report, owner remove-post, Members tab
**Files:** `services/api.js`, `pages/GroupPage.jsx`, `styles.css`; Create `components/groups/GroupMembers.jsx`.

- [ ] **api.js** — in `groups:` add:
```js
    members: (slug) => request(`/groups/${slug}/members`),
    report: (id, reason, details = '') => request(`/groups/${id}/report`, { method: 'POST', body: { reason, details } }),
    removePost: (id, postId) => request(`/groups/${id}/posts/${postId}`, { method: 'DELETE' }),
    removeMember: (id, userId) => request(`/groups/${id}/members/${userId}`, { method: 'DELETE' }),
```
named exports: `getGroupMembers`, `reportGroup`, `removeGroupPost`, `removeGroupMember`.

- [ ] **GroupMembers.jsx** (NEW):
```jsx
import { createSignal, onMount, For, Show } from 'solid-js';
import { getGroupMembers, removeGroupMember } from '../../services/api';

export default function GroupMembers(props) {
  const [members, setMembers] = createSignal([]);
  const [busy, setBusy] = createSignal(false);
  const load = async () => { try { const r = await getGroupMembers(props.group.slug); setMembers(r.members || []); } catch { setMembers([]); } };
  onMount(load);
  const kick = async (userId) => { setBusy(true); try { const r = await removeGroupMember(props.group.id, userId); props.onMemberRemoved?.(r.member_count); await load(); } catch {} finally { setBusy(false); } };
  return (
    <div class="group-members">
      <For each={members()}>
        {(m) => (
          <div class="group-member-row">
            <a class="group-member-name" href={`#user/${m.user_id}`}>@{m.username}</a>
            <Show when={m.role === 'owner'}><span class="group-chip">Owner</span></Show>
            <Show when={props.isOwner && m.role !== 'owner'}>
              <button type="button" class="group-market-unpin" onClick={() => kick(m.user_id)} disabled={busy()}>Remove</button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
```
- [ ] **GroupPage** — imports `GroupMembers`, and `reportGroup`, `removeGroupPost` from api.
  - **Report control** in the header `.group-detail-actions` (after the Join button), for logged-in non-owners:
```jsx
              <Show when={isAuthenticated() && !group().is_owner}>
                <button type="button" class="group-report" onClick={() => setReporting(true)}>Report</button>
              </Show>
```
  with state `const [reporting, setReporting] = createSignal(false); const [reportMsg, setReportMsg] = createSignal('');` and, below the header actions, an inline prompt:
```jsx
            <Show when={reporting()}>
              <form class="group-report-form" onSubmit={async (e) => { e.preventDefault(); const r = e.currentTarget.reason.value.trim(); if (!r) return; try { await reportGroup(group().id, r); setReportMsg('Reported — thanks.'); } catch { setReportMsg('Could not report.'); } setReporting(false); }}>
                <input name="reason" class="group-create-input" placeholder="Why are you reporting this group?" />
                <button type="submit" class="button">Submit report</button>
              </form>
            </Show>
            <Show when={reportMsg()}><p class="groups-empty">{reportMsg()}</p></Show>
```
  - **Owner remove-post** in the Feed tab list: wrap each `PostItem` so the owner gets a Remove control:
```jsx
                <For each={posts()}>{(p) => (
                  <div class="group-feed-item">
                    <Show when={group().is_owner}>
                      <button type="button" class="group-post-remove" onClick={async () => { try { await removeGroupPost(group().id, p.id); setPosts((c) => c.filter((x) => x.id !== p.id)); } catch {} }}>Remove</button>
                    </Show>
                    <PostItem post={p} onPostUpdate={() => {}} onPostDelete={() => setPosts((c) => c.filter((x) => x.id !== p.id))} />
                  </div>
                )}</For>
```
  - **Members tab**: add a 4th tab button `<button type="button" class={`group-tab ${tab() === 'members' ? 'on' : ''}`} onClick={() => setTab('members')}>Members</button>` and body block `<Show when={tab() === 'members'}><GroupMembers group={group()} isOwner={group().is_owner} onMemberRemoved={(c) => setGroup({ ...group(), member_count: c })} /></Show>`. (`setGroup` is the existing group signal setter — confirm its name.)
- [ ] **styles.css** append:
```css
.group-report { border: 1px solid var(--border-color); background: var(--card-bg); border-radius: var(--border-radius); font: inherit; font-size: 0.72rem; padding: 0.2rem 0.55rem; cursor: pointer; }
.group-report-form { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
.group-members { display: grid; gap: 0.4rem; padding: 0.9rem; text-align: left; }
.group-member-row { display: flex; align-items: center; gap: 0.6rem; }
.group-member-name { font-weight: 700; }
.group-feed-item { position: relative; }
.group-post-remove { font-size: 0.7rem; border: 1px solid var(--border-color); background: var(--card-bg); border-radius: var(--border-radius); padding: 0.1rem 0.45rem; cursor: pointer; margin-bottom: 0.2rem; }
```
- [ ] Verify compile on solid-local; commit `feat(groups): moderation UI (report, remove post, members tab)`.

---

### Task 3: Smoke + finalize
- [ ] Playwright `tests/e2e/community-group-moderation.spec.js`: owner + a second member; member joins; owner opens **Members** tab, clicks **Remove** on the member, asserts they disappear and the header count drops. (Optionally: a user clicks Report, submits a reason, sees the confirmation.)
- [ ] backend moderation test green; tear down solid-local; merge `--no-ff`; push; restart backend + frontend; `gh run watch` green.

## Notes
- Report reuses `moderation_reports` (type 'group'); admins review via existing `/admin/moderation/reports`.
- Owner-remove-post hard-deletes (a group post has no other home). Kick can't target the owner; member_count maintained transactionally.
- Route ordering: the new DELETE routes (`/groups/:id/posts/:postId`, `/groups/:id/members/:userId`) don't collide with the GET `/groups/:slug/...` routes (different method/segments).
