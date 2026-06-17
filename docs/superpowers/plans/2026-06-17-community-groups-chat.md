# Community Groups — Chat (Sub-project C) Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** A public real-time chat room per group on the Chat tab.

**Architecture:** `community_group_messages` table; `GET /groups/:slug/messages` (history) + `POST /groups/:id/messages` (member-only) that broadcasts over Socket.io room `group-chat:<id>`; a `GroupChat` component joins the room and appends live.

**Spec:** `docs/superpowers/specs/2026-06-17-community-groups-chat-design.md`

**Conventions:** backend tests via `docker exec intellacc_backend npx jest …`; restart `intellacc_backend` after edits; frontend dev `docker compose -p solid-local …` (ALWAYS `-p solid-local`), 4174. `req.app.get('io')` gives the Socket.io instance in controllers; `socket.join('room')` handlers live in `backend/src/index.js` `io.on('connection')`.

---

### Task 1: Migration
**File:** Create `backend/migrations/20260619_community_group_messages.sql`
```sql
CREATE TABLE IF NOT EXISTS community_group_messages (
  id         SERIAL PRIMARY KEY,
  group_id   INT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cgmsg_group ON community_group_messages (group_id, created_at);
```
Apply via psql (as prior migrations), verify `\d community_group_messages`, commit `feat(groups): community_group_messages table`.

---

### Task 2: Backend — messages endpoints + socket handlers
**Files:** Modify `communityGroupsController.js`, `routes/api.js`, `index.js`; Test `backend/test/community_group_chat.test.js`.

- [ ] **Test** (`community_group_chat.test.js`): mirror `community_group_feed.test.js`'s `mkUser`/`firstTopic` helpers. Then:
```js
  test('member sends a message; non-member 403; empty 400; history is chronological', async () => {
    const owner = await mkUser('gcowner', 2);
    const stranger = await mkUser('gcstranger', 2);
    cleanup.userIds.push(owner.id, stranger.id);
    const topicId = await firstTopic();
    const g = await request(app).post('/api/groups').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Chat group test', description: '', topic_id: topicId });
    const { id, slug } = g.body.group;
    cleanup.groupIds.push(id);

    const m1 = await request(app).post(`/api/groups/${id}/messages`).set('Authorization', `Bearer ${owner.token}`).send({ content: 'hello one' });
    expect(m1.statusCode).toBe(201);
    expect(m1.body.message.content).toBe('hello one');
    expect(m1.body.message.username).toBeTruthy();

    const denied = await request(app).post(`/api/groups/${id}/messages`).set('Authorization', `Bearer ${stranger.token}`).send({ content: 'hi' });
    expect(denied.statusCode).toBe(403);

    const empty = await request(app).post(`/api/groups/${id}/messages`).set('Authorization', `Bearer ${owner.token}`).send({ content: '   ' });
    expect(empty.statusCode).toBe(400);

    await request(app).post(`/api/groups/${id}/messages`).set('Authorization', `Bearer ${owner.token}`).send({ content: 'hello two' });
    const hist = await request(app).get(`/api/groups/${slug}/messages`);
    expect(hist.statusCode).toBe(200);
    const texts = hist.body.messages.map((m) => m.content);
    expect(texts.slice(-2)).toEqual(['hello one', 'hello two']);
  });
```

- [ ] **Controller** — append to `communityGroupsController.js`:
```js
exports.getGroupMessages = async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE slug = $1 AND removed_at IS NULL', [req.params.slug]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const result = await db.query(
      `SELECT m.id, m.user_id, u.username, m.content, m.created_at
       FROM community_group_messages m JOIN users u ON u.id = m.user_id
       WHERE m.group_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
      [g.rows[0].id, limit]
    );
    res.json({ messages: result.rows.reverse() });
  } catch (err) {
    console.error('Error listing group messages:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.postGroupMessage = async (req, res) => {
  const viewerId = getViewerId(req);
  const groupId = parseInt(req.params.id, 10);
  const content = String(req.body?.content || '').trim();
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  if (!content) return res.status(400).json({ message: 'Message cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ message: 'Message too long (max 1000)' });
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const mem = await db.query('SELECT 1 FROM community_group_members WHERE group_id = $1 AND user_id = $2', [groupId, viewerId]);
    if (mem.rows.length === 0) return res.status(403).json({ message: 'Join the group to chat' });
    const ins = await db.query(
      `INSERT INTO community_group_messages (group_id, user_id, content) VALUES ($1, $2, $3)
       RETURNING id, user_id, content, created_at`,
      [groupId, viewerId, content]
    );
    const u = await db.query('SELECT username FROM users WHERE id = $1', [viewerId]);
    const message = { ...ins.rows[0], username: u.rows[0]?.username || `user-${viewerId}` };
    const io = req.app.get('io');
    if (io) io.to(`group-chat:${groupId}`).emit('group-message', message);
    res.status(201).json({ message });
  } catch (err) {
    console.error('Error posting group message:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
```
- [ ] **Routes** (`api.js`, after `/groups/:slug/posts`):
```js
router.get('/groups/:slug/messages', optionalAuth, communityGroupsController.getGroupMessages);
router.post('/groups/:id/messages', authenticateJWT, communityGroupsController.postGroupMessage);
```
- [ ] **Socket handlers** — in `backend/src/index.js`, inside `io.on('connection', (socket) => { … })`, next to the other `socket.on('join-…')` handlers, add:
```js
  socket.on('join-group-chat', (groupId) => { socket.join(`group-chat:${Number(groupId)}`); });
  socket.on('leave-group-chat', (groupId) => { socket.leave(`group-chat:${Number(groupId)}`); });
```
- [ ] Restart backend; run the test (expect PASS). Commit `feat(groups): group chat messages endpoints + socket room`.

---

### Task 3: Frontend — socket helpers, api, GroupChat, enable Chat tab
**Files:** Modify `services/socket.js`, `services/api.js`, `pages/GroupPage.jsx`, `styles.css`; Create `components/groups/GroupChat.jsx`.

- [ ] **socket.js** — export (following the file's singleton `socket` + `connect()` pattern):
```js
export const joinGroupChat = (groupId, handler) => {
  connect();
  if (socket) { socket.emit('join-group-chat', groupId); socket.on('group-message', handler); }
};
export const leaveGroupChat = (groupId, handler) => {
  if (socket) { socket.emit('leave-group-chat', groupId); socket.off('group-message', handler); }
};
```
(If `socket`/`connect` aren't in scope for an exported fn, expose them as the file already does for other exports; adapt to the actual structure.)

- [ ] **api.js** — in `groups:` add `messages: (slug, { limit = 50 } = {}) => request(`/groups/${slug}/messages?limit=${limit}`)` and `sendMessage: (id, content) => request(`/groups/${id}/messages`, { method: 'POST', body: { content } })`; named exports `export const getGroupMessages = (slug, opts) => api.groups.messages(slug, opts);` and `export const sendGroupMessage = (id, content) => api.groups.sendMessage(id, content);`.

- [ ] **GroupChat.jsx** (NEW):
```jsx
import { createSignal, onMount, onCleanup, For, Show } from 'solid-js';
import { getGroupMessages, sendGroupMessage } from '../../services/api';
import { joinGroupChat, leaveGroupChat } from '../../services/socket';

export default function GroupChat(props) {
  const [messages, setMessages] = createSignal([]);
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  let listRef;
  const scrollDown = () => { if (listRef) listRef.scrollTop = listRef.scrollHeight; };
  const append = (m) => { setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m])); queueMicrotask(scrollDown); };

  const onMsg = (m) => { if (Number(m.group_id ?? props.group.id) === Number(props.group.id) || m.id) append(m); };

  onMount(async () => {
    try { const r = await getGroupMessages(props.group.slug, { limit: 50 }); setMessages(r.messages || []); queueMicrotask(scrollDown); } catch { /* empty */ }
    joinGroupChat(props.group.id, onMsg);
  });
  onCleanup(() => leaveGroupChat(props.group.id, onMsg));

  const send = async (e) => {
    e.preventDefault();
    const c = text().trim();
    if (!c || sending()) return;
    setSending(true);
    try { await sendGroupMessage(props.group.id, c); setText(''); } catch { /* keep text */ } finally { setSending(false); }
  };

  return (
    <div class="group-chat">
      <div class="group-chat-list" ref={(el) => (listRef = el)}>
        <Show when={messages().length === 0}><p class="groups-empty">No messages yet.</p></Show>
        <For each={messages()}>
          {(m) => (
            <div class="group-chat-msg">
              <span class="group-chat-user">{m.username || `user-${m.user_id}`}</span>
              <span class="group-chat-text">{m.content}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.group.is_member} fallback={<p class="groups-empty">Join this group to chat.</p>}>
        <form class="group-chat-form" onSubmit={send}>
          <input class="group-chat-input" value={text()} onInput={(e) => setText(e.currentTarget.value)} placeholder="Message…" maxlength="1000" />
          <button type="submit" class="button primary" disabled={sending()}>Send</button>
        </form>
      </Show>
    </div>
  );
}
```
Note: the broadcast `group-message` payload doesn't include `group_id`; since a client only joins ONE group's room at a time, every `group-message` it receives belongs to the current group — `onMsg` appends them. (The `m.id` truthy check in onMsg keeps it simple.)

- [ ] **GroupPage** — import `GroupChat`; enable the Chat tab: change the disabled Chat `<button>` to `<button class={`group-tab ${tab() === 'chat' ? 'on' : ''}`} onClick={() => setTab('chat')}>Chat</button>`; and in the body, render chat when `tab() === 'chat'`:
```jsx
              <Show when={tab() === 'chat'}><GroupChat group={group()} /></Show>
```
(keep Feed as built in B; Markets stays disabled "later"). Ensure the body wrapper allows chat (left-aligned) — reuse `.group-feed-body` class condition for `tab()==='chat'` too, or add `.group-chat` styling.

- [ ] **styles.css** append:
```css
.group-chat { display: grid; gap: 0.6rem; padding: 0.9rem; text-align: left; }
.group-chat-list { max-height: 320px; overflow-y: auto; display: grid; gap: 0.35rem; border: 1px solid var(--border-color); border-radius: var(--border-radius); padding: 0.6rem; background: #fff; }
.group-chat-msg { font-size: 0.9rem; }
.group-chat-user { font-weight: 700; margin-right: 0.4rem; }
.group-chat-form { display: flex; gap: 0.5rem; }
.group-chat-input { flex: 1; border: 1px solid var(--border-color); border-radius: var(--border-radius); padding: 0.45rem 0.5rem; font: inherit; }
```
- [ ] Verify compile on solid-local; commit `feat(groups): group Chat tab (realtime)`.

---

### Task 4: Smoke + finalize
- [ ] Playwright `tests/e2e/community-group-chat.spec.js`: tier≥2 member opens a group, clicks Chat tab, sends a message via the input, asserts it appears in `.group-chat-list`. Run `KEEP_E2E_USERS=0 npx playwright test … --reporter=line`.
- [ ] backend chat test green; tear down solid-local; merge `--no-ff`; push; restart backend + frontend; `gh run watch` until green.

## Notes
- Chat is plaintext/public (not MLS). Membership enforced on send (REST), not on join/read.
- Sender receives its own message via the broadcast (no optimistic add → no dupes).
- The broadcast payload omits `group_id`; a client is only in one group room at a time, so all received `group-message` events are for the open group.
