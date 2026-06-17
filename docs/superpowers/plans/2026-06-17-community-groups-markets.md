# Community Groups — Pinned Markets (Sub-project D) Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Owner pins/unpins markets to a group; the Markets tab lists them.

**Spec:** `docs/superpowers/specs/2026-06-17-community-groups-markets-design.md`

**Conventions:** backend tests `docker exec intellacc_backend npx jest …`; restart backend after edits; frontend `docker compose -p solid-local …` (ALWAYS `-p solid-local`), 4174. Owner/admin check mirrors the existing `deleteGroup` in `communityGroupsController.js`.

---

### Task 1: Migration
**File:** `backend/migrations/20260620_community_group_markets.sql`
```sql
CREATE TABLE IF NOT EXISTS community_group_markets (
  group_id  INT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
  event_id  INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  pinned_by INT REFERENCES users(id) ON DELETE SET NULL,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_cgmarkets_group ON community_group_markets (group_id, pinned_at DESC);
```
Apply via psql, verify `\d community_group_markets`, commit `feat(groups): community_group_markets table`.

---

### Task 2: Backend — pin / unpin / list
**Files:** `communityGroupsController.js`, `routes/api.js`; Test `backend/test/community_group_markets.test.js`.

- [ ] **Test** (reuse `mkUser`/`firstTopic` style; also seed an event):
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
const mkEvent = async () => (await db.query(
  `INSERT INTO events (title, details, closing_date, event_type, category) VALUES ($1,'d',NOW()+INTERVAL '30 days','binary','test') RETURNING id`,
  [`Pin target ${Date.now()}_${Math.floor(Math.random()*1e6)}`])).rows[0].id;

describe('Community group markets', () => {
  const cleanup = { userIds: [], groupIds: [], eventIds: [] };
  afterAll(async () => {
    if (cleanup.groupIds.length) await db.query('DELETE FROM community_groups WHERE id = ANY($1::int[])', [cleanup.groupIds]);
    if (cleanup.eventIds.length) await db.query('DELETE FROM events WHERE id = ANY($1::int[])', [cleanup.eventIds]);
    if (cleanup.userIds.length) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
  });

  test('owner pins/unpins; non-owner 403; missing event 404; list returns pinned', async () => {
    const owner = await mkUser('gmowner', 2);
    const other = await mkUser('gmother', 2);
    cleanup.userIds.push(owner.id, other.id);
    const topicId = await firstTopic();
    const eventId = await mkEvent();
    cleanup.eventIds.push(eventId);
    const g = await request(app).post('/api/groups').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Markets group test', description: '', topic_id: topicId });
    const { id, slug } = g.body.group;
    cleanup.groupIds.push(id);

    const denied = await request(app).post(`/api/groups/${id}/markets`).set('Authorization', `Bearer ${other.token}`).send({ event_id: eventId });
    expect(denied.statusCode).toBe(403);

    const missing = await request(app).post(`/api/groups/${id}/markets`).set('Authorization', `Bearer ${owner.token}`).send({ event_id: 999999999 });
    expect(missing.statusCode).toBe(404);

    const pinned = await request(app).post(`/api/groups/${id}/markets`).set('Authorization', `Bearer ${owner.token}`).send({ event_id: eventId });
    expect(pinned.statusCode).toBe(200);
    const pinAgain = await request(app).post(`/api/groups/${id}/markets`).set('Authorization', `Bearer ${owner.token}`).send({ event_id: eventId });
    expect(pinAgain.statusCode).toBe(200); // idempotent

    const list = await request(app).get(`/api/groups/${slug}/markets`);
    expect(list.statusCode).toBe(200);
    const m = list.body.markets.find((x) => x.event_id === eventId);
    expect(m).toBeTruthy();
    expect(m.title).toBeTruthy();

    const unpin = await request(app).delete(`/api/groups/${id}/markets/${eventId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(unpin.statusCode).toBe(200);
    const list2 = await request(app).get(`/api/groups/${slug}/markets`);
    expect(list2.body.markets.find((x) => x.event_id === eventId)).toBeFalsy();
  });
});
```

- [ ] **Controller** — append to `communityGroupsController.js`:
```js
// Load a group's created_by and assert the viewer may manage it (owner or admin).
const assertCanManage = async (groupId, req) => {
  const g = await db.query('SELECT created_by FROM community_groups WHERE id = $1 AND removed_at IS NULL', [groupId]);
  if (g.rows.length === 0) return { error: 404, message: 'Group not found' };
  const viewerId = getViewerId(req);
  if (Number(g.rows[0].created_by) !== Number(viewerId) && req.user?.role !== 'admin') {
    return { error: 403, message: 'Only the owner or an admin can manage this group' };
  }
  return { ok: true };
};

exports.getGroupMarkets = async (req, res) => {
  try {
    const g = await db.query('SELECT id FROM community_groups WHERE slug = $1 AND removed_at IS NULL', [req.params.slug]);
    if (g.rows.length === 0) return res.status(404).json({ message: 'Group not found' });
    const result = await db.query(
      `SELECT cgm.event_id, e.title, e.market_prob, e.closing_date, e.outcome
       FROM community_group_markets cgm JOIN events e ON e.id = cgm.event_id
       WHERE cgm.group_id = $1 ORDER BY cgm.pinned_at DESC`,
      [g.rows[0].id]
    );
    res.json({ markets: result.rows });
  } catch (err) {
    console.error('Error listing group markets:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.pinGroupMarket = async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const eventId = parseInt(req.body?.event_id, 10);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: 'Invalid group id' });
  if (!Number.isInteger(eventId)) return res.status(400).json({ message: 'Invalid event id' });
  try {
    const can = await assertCanManage(groupId, req);
    if (can.error) return res.status(can.error).json({ message: can.message });
    const ev = await db.query('SELECT id FROM events WHERE id = $1', [eventId]);
    if (ev.rows.length === 0) return res.status(404).json({ message: 'Market not found' });
    await db.query(
      `INSERT INTO community_group_markets (group_id, event_id, pinned_by) VALUES ($1, $2, $3)
       ON CONFLICT (group_id, event_id) DO NOTHING`,
      [groupId, eventId, getViewerId(req)]
    );
    res.json({ pinned: true });
  } catch (err) {
    console.error('Error pinning market:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.unpinGroupMarket = async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const eventId = parseInt(req.params.eventId, 10);
  if (!Number.isInteger(groupId) || !Number.isInteger(eventId)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const can = await assertCanManage(groupId, req);
    if (can.error) return res.status(can.error).json({ message: can.message });
    await db.query('DELETE FROM community_group_markets WHERE group_id = $1 AND event_id = $2', [groupId, eventId]);
    res.json({ pinned: false });
  } catch (err) {
    console.error('Error unpinning market:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
```
- [ ] **Routes** (`api.js`, after `/groups/:id/messages`):
```js
router.get('/groups/:slug/markets', optionalAuth, communityGroupsController.getGroupMarkets);
router.post('/groups/:id/markets', authenticateJWT, communityGroupsController.pinGroupMarket);
router.delete('/groups/:id/markets/:eventId', authenticateJWT, communityGroupsController.unpinGroupMarket);
```
- [ ] Restart backend; run test (expect PASS). Commit `feat(groups): pin/unpin/list group markets`.

---

### Task 3: Frontend — Markets tab
**Files:** `services/api.js`, `pages/GroupPage.jsx`, `styles.css`; Create `components/groups/GroupMarkets.jsx`.

- [ ] **api.js** — in `groups:` add:
```js
    markets: (slug) => request(`/groups/${slug}/markets`),
    pinMarket: (id, eventId) => request(`/groups/${id}/markets`, { method: 'POST', body: { event_id: eventId } }),
    unpinMarket: (id, eventId) => request(`/groups/${id}/markets/${eventId}`, { method: 'DELETE' }),
```
named exports: `export const getGroupMarkets = (slug) => api.groups.markets(slug); export const pinGroupMarket = (id, e) => api.groups.pinMarket(id, e); export const unpinGroupMarket = (id, e) => api.groups.unpinMarket(id, e);`

- [ ] **GroupMarkets.jsx** (NEW):
```jsx
import { createSignal, onMount, For, Show } from 'solid-js';
import { getGroupMarkets, pinGroupMarket, unpinGroupMarket, getEvents } from '../../services/api';

const pct = (p) => (p == null ? '—' : `${Math.round(Number(p) * 100)}%`);
const day = (d) => (d ? new Date(d).toLocaleDateString() : '');

export default function GroupMarkets(props) {
  const [markets, setMarkets] = createSignal([]);
  const [q, setQ] = createSignal('');
  const [results, setResults] = createSignal([]);
  const [busy, setBusy] = createSignal(false);

  const load = async () => { try { const r = await getGroupMarkets(props.group.slug); setMarkets(r.markets || []); } catch { setMarkets([]); } };
  onMount(load);

  const search = async () => {
    const text = q().trim();
    if (text.length < 2) { setResults([]); return; }
    try { const evs = await getEvents(text); setResults((Array.isArray(evs) ? evs : []).slice(0, 5)); } catch { setResults([]); }
  };
  const pin = async (eventId) => { setBusy(true); try { await pinGroupMarket(props.group.id, eventId); setQ(''); setResults([]); await load(); } catch {} finally { setBusy(false); } };
  const unpin = async (eventId) => { setBusy(true); try { await unpinGroupMarket(props.group.id, eventId); await load(); } catch {} finally { setBusy(false); } };

  return (
    <div class="group-markets">
      <Show when={props.isOwner}>
        <div class="group-markets-pin">
          <input class="group-create-input" value={q()} onInput={(e) => setQ(e.currentTarget.value)} onBlur={search}
            placeholder="Search a market to pin…" />
          <button type="button" class="button" onClick={search} disabled={busy()}>Search</button>
          <Show when={results().length > 0}>
            <div class="group-markets-results">
              <For each={results()}>
                {(ev) => (
                  <div class="group-markets-result">
                    <span class="group-markets-rtitle">{ev.title}</span>
                    <button type="button" class="group-join" onClick={() => pin(ev.id)} disabled={busy()}>Pin</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={markets().length === 0}><p class="groups-empty">No markets pinned yet.</p></Show>
      <div class="group-markets-list">
        <For each={markets()}>
          {(m) => (
            <div class="group-market-card">
              <a class="group-market-title" href={`#predictions/${m.event_id}`}>{m.title}</a>
              <div class="group-market-meta">
                <span>{m.outcome ? `Resolved: ${m.outcome}` : `Prob ${pct(m.market_prob)}`}</span>
                <span>{m.closing_date ? `Closes ${day(m.closing_date)}` : ''}</span>
                <Show when={props.isOwner}><button type="button" class="group-market-unpin" onClick={() => unpin(m.event_id)} disabled={busy()}>Unpin</button></Show>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
```
- [ ] **GroupPage** — import `GroupMarkets`; enable the Markets tab button (`<button class={`group-tab ${tab() === 'markets' ? 'on' : ''}`} onClick={() => setTab('markets')}>Markets</button>`); render in body when `tab() === 'markets'`:
```jsx
              <Show when={tab() === 'markets'}><GroupMarkets group={group()} isOwner={group().is_owner} /></Show>
```
Remove the now-unused "Coming soon." markets placeholder.
- [ ] **styles.css** append:
```css
.group-markets { display: grid; gap: 0.8rem; padding: 0.9rem; text-align: left; }
.group-markets-pin { display: grid; gap: 0.5rem; }
.group-markets-results { display: grid; gap: 0.3rem; }
.group-markets-result { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; border: 1px solid var(--border-color); border-radius: var(--border-radius); padding: 0.35rem 0.5rem; }
.group-markets-rtitle { font-size: 0.85rem; }
.group-markets-list { display: grid; gap: 0.5rem; }
.group-market-card { border: 1px solid var(--border-color); border-radius: var(--border-radius); padding: 0.6rem 0.75rem; background: var(--card-bg); }
.group-market-title { font-weight: 700; }
.group-market-meta { display: flex; align-items: center; gap: 0.9rem; font-size: 0.82rem; color: var(--secondary-text); margin-top: 0.3rem; }
.group-market-unpin { margin-left: auto; border: 1px solid var(--border-color); background: var(--card-bg); border-radius: var(--border-radius); font: inherit; font-size: 0.72rem; padding: 0.15rem 0.5rem; cursor: pointer; }
```
- [ ] Verify compile on solid-local; commit `feat(groups): group Markets tab (pin/unpin)`.

---

### Task 4: Smoke + finalize
- [ ] Playwright `tests/e2e/community-group-markets.spec.js`: seed an event (insert via `dbQuery` or POST as a payment-verified user); owner opens Markets tab, searches its title, clicks Pin, asserts the market card appears; clicks Unpin, asserts it's gone.
- [ ] backend markets test green; tear down solid-local; merge `--no-ff`; push; restart backend + frontend; `gh run watch` green.

## Notes
- Pin/unpin owner-or-admin; list is public. Pin is idempotent (ON CONFLICT DO NOTHING → 200).
- Reuses `getEvents(search)` for the picker and `#predictions/:id` for the market link.
