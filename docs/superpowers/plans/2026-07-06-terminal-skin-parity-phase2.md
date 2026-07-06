# Terminal Skin Parity — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminal-native PROFILE, NOTIFICATIONS, and SEARCH views; feed comments, images, and reposts; van feed-source parity (following-feed + discover fallback + ranking weights); weekly-question slot with market deep-linking.

**Architecture:** Extends Phase 1's view registry (`TERMINAL_VIEWS`) with three new lazy views; enriches the terminal `PostItem`/`feedStore` natively (no van components); market pane gains `ensureMarket(id)` for `#predictions/:id` deep links. All data access via existing `services/api.js` — no api.js or backend changes.

**Tech Stack:** SolidJS + Tailwind bb-* tokens, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-05-terminal-skin-parity-design.md`
**Phase 1 plan (interfaces referenced throughout):** `docs/superpowers/plans/2026-07-05-terminal-skin-parity-phase1.md`

## Global Constraints

- Branch `worktree-bloomberg-tmux-skin` in the worktree at `.claude/worktrees/bloomberg-tmux-skin`; base stays `predictions-declutter-tabs`.
- No van page components or van CSS; terminal UI = Tailwind bb-* tokens, UPPERCASE mono copy, `[BRACKET]` chrome, no emojis.
- No api.js modifications; no new backend endpoints.
- Import `getCurrentUserId` from `../services/auth` (synchronous), NEVER from `services/api` (that one is an async alias of getCurrentUser).
- Window event contract `rp-balance-refresh` exists (Phase 1); reuse, don't rename.
- Views register in `frontend-solid/src/components/terminal/views/registry.js` as `{ title, component: lazy(...) }`; components receive `props.param` (string|null). Closing routes to `#home` via `closeTerminalView` from `../TerminalViewHost`.
- Stores use the request-epoch convention: module-level `let fetchEpoch = 0`, capture `const epoch = ++fetchEpoch` per fetch, discard superseded responses on success AND catch paths, `clear()` does `fetchEpoch++`.
- E2E: helpers `createUser`, `cleanupUsers`, `provisionTier` (SYNCHRONOUS — no await needed), `apiFetch`, `dbQuery`, `SOLID_URL` from `tests/e2e/helpers/solidMessaging.js`; force skin with `?skin=terminal`; ALWAYS `provisionTier(u)` right after `createUser` when the test posts anything.
- KNOWN BACKEND BUG: ~10 rapid POSTs by one user wedge the API (pg pool). Space seeded posts/comments ≥200ms apart; keep total seeds per user under 10 where possible (or split across two users).
- Test server: worktree Vite dev on port 4175 (proxy → backend container IP). Run Playwright from worktree root with `SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175`.
- TDD per task: spec first → RED → implement → GREEN. Commit per task with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: PROFILE view (`#profile` own, `#user/:id` other)

**Files:**
- Create: `frontend-solid/src/components/terminal/views/ProfileView.jsx`
- Modify: `frontend-solid/src/components/terminal/views/registry.js`
- Test: `tests/e2e/terminal-profile.spec.js`

**Interfaces:**
- Consumes: `getCurrentUser()`, `getUser(id)`, `getFollowingStatus(id)` → `{isFollowing}`, `followUser(id)`, `unfollowUser(id)`, `getFollowers(id)`, `getFollowing(id)`, `getPredictions()`, `createDirectMessage(userId)` — all named exports of `services/api`; `getCurrentUserId` from `services/auth`; `isLoggedIn` from `services/tokenService`.
- Produces: registry keys `profile` and `user` (both → ProfileView; `user` passes `props.param` = target user id). Palette label for `profile` only ("Open Profile") — palette derives from the registry automatically, and duplicate near-identical entries are acceptable; if the double entry ("Open User") reads badly, add an optional `hidden: true` flag on the `user` registry entry and filter `Object.entries(TERMINAL_VIEWS).filter(([,v]) => !v.hidden)` in TerminalApp's palette actions. Later tasks rely on `hidden` existing.

- [ ] **Step 1: Write the failing e2e test**

```js
// tests/e2e/terminal-profile.spec.js
// Terminal-native profile view: own profile stats + other-user follow flow.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

async function loginTerminal(page, u) {
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
}

test('own profile shows stats grid', async ({ page }) => {
  const u = await createUser('tprof1');
  created.push(u);
  await loginTerminal(page, u);

  await page.evaluate(() => { window.location.hash = '#profile'; });
  const view = page.locator('[data-view="profile"]');
  await expect(view).toBeVisible({ timeout: 10000 });
  await expect(view).toContainText(`@${u.username}`);
  await expect(view.locator('[data-testid="profile-stat-balance"]')).toContainText(/RP/);
  await expect(view.locator('[data-testid="profile-stat-reputation"]')).toContainText(/RP/);
});

test('other-user profile follows and unfollows', async ({ page }) => {
  const a = await createUser('tprof2a');
  const b = await createUser('tprof2b');
  created.push(a, b);
  await loginTerminal(page, a);

  await page.evaluate((id) => { window.location.hash = `#user/${id}`; }, String(b.id));
  const view = page.locator('[data-view="user"]');
  await expect(view).toBeVisible({ timeout: 10000 });
  await expect(view).toContainText(`@${b.username}`);

  const followBtn = view.locator('[data-testid="profile-follow"]');
  await expect(followBtn).toContainText('[FOLLOW]', { timeout: 10000 });
  await followBtn.click();
  await expect(followBtn).toContainText('[UNFOLLOW]', { timeout: 10000 });
  await followBtn.click();
  await expect(followBtn).toContainText('[FOLLOW]', { timeout: 10000 });
});
```

- [ ] **Step 2: Run to verify it fails** (`[data-view="profile"]` never appears)

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-profile.spec.js
```

- [ ] **Step 3: Create ProfileView**

```jsx
// frontend-solid/src/components/terminal/views/ProfileView.jsx
import { For, Show, createEffect, createSignal } from 'solid-js';
import {
  createDirectMessage,
  followUser,
  getCurrentUser,
  getFollowers,
  getFollowing,
  getFollowingStatus,
  getPredictions,
  getUser,
  unfollowUser
} from '../../../services/api';
import { getCurrentUserId } from '../../../services/auth';
import { isLoggedIn } from '../../../services/tokenService';

const fmtRP = (v) => `${(Number(v) || 0).toFixed(2)} RP`;

const Stat = (props) => (
  <div class="bg-bb-panel border border-bb-border p-2" data-testid={props.testid}>
    <div class="text-xxs text-bb-muted uppercase">{props.label}</div>
    <div class="text-lg font-bold text-bb-accent">{props.value}</div>
  </div>
);

export default function ProfileView(props) {
  const [profile, setProfile] = createSignal(null);
  const [predictions, setPredictions] = createSignal([]);
  const [following, setFollowing] = createSignal(null); // null | boolean
  const [network, setNetwork] = createSignal(null); // null | { followers, following }
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const targetId = () => (props.param ? String(props.param) : null);
  const isOwn = () => {
    const current = getCurrentUserId();
    if (!targetId()) return true;
    return current != null && String(current) === targetId();
  };

  createEffect(() => {
    const id = targetId();
    setProfile(null);
    setPredictions([]);
    setFollowing(null);
    setNetwork(null);
    setError('');
    const load = async () => {
      try {
        const p = id && !isOwn() ? await getUser(id) : await getCurrentUser();
        setProfile(p?.user || p);
        if (isOwn()) {
          getPredictions().then((rows) => {
            const items = Array.isArray(rows) ? rows : (rows?.items || rows?.predictions || []);
            setPredictions(items.slice(0, 5));
          }).catch(() => {});
        } else if (isLoggedIn()) {
          getFollowingStatus(id).then((s) => setFollowing(Boolean(s?.isFollowing))).catch(() => {});
        }
      } catch (e) {
        setError(e?.message || 'FAILED TO LOAD PROFILE');
      }
    };
    load();
  });

  const toggleFollow = async () => {
    const id = targetId();
    if (!id || busy()) return;
    setBusy(true);
    try {
      if (following()) {
        await unfollowUser(id);
        setFollowing(false);
      } else {
        await followUser(id);
        setFollowing(true);
      }
    } catch (e) {
      setError(e?.message || 'FOLLOW ACTION FAILED');
    } finally {
      setBusy(false);
    }
  };

  const loadNetwork = async () => {
    const id = targetId() || String(getCurrentUserId() || '');
    if (!id) return;
    try {
      const [flw, fin] = await Promise.all([
        getFollowers(id).catch(() => []),
        getFollowing(id).catch(() => [])
      ]);
      const rows = (v, keys) => Array.isArray(v) ? v : (keys.map(k => v?.[k]).find(Array.isArray) || []);
      setNetwork({
        followers: rows(flw, ['items', 'followers']),
        following: rows(fin, ['items', 'following'])
      });
    } catch { /* per-call catches above */ }
  };

  const message = async () => {
    try {
      await createDirectMessage(targetId());
      window.location.hash = '#messages';
    } catch (e) {
      setError(e?.message || 'FAILED TO START DM');
    }
  };

  return (
    <div class="p-4 font-mono text-sm max-w-3xl">
      <Show when={error()}>
        <div class="mb-3 p-2 border border-market-down/50 bg-market-down/10 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>
      </Show>
      <Show when={profile()} fallback={<div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>}>
        <div class="flex items-baseline justify-between border-b border-bb-border pb-2 mb-4">
          <div>
            <span class="text-bb-accent font-bold text-lg">@{profile().username}</span>
            <Show when={profile().display_name}>
              <span class="text-bb-muted ml-2">// {profile().display_name}</span>
            </Show>
          </div>
          <div class="flex gap-2 text-xs">
            <Show when={!isOwn() && isLoggedIn()}>
              <button
                type="button"
                data-testid="profile-follow"
                disabled={busy() || following() == null}
                onClick={toggleFollow}
                class="px-2 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
              >
                {following() ? '[UNFOLLOW]' : '[FOLLOW]'}
              </button>
              <button
                type="button"
                data-testid="profile-message"
                onClick={message}
                class="px-2 py-1 border border-bb-border text-bb-text hover:bg-white/10 uppercase font-bold"
              >
                [MSG]
              </button>
            </Show>
          </div>
        </div>

        <Show when={profile().bio}>
          <p class="text-bb-text mb-4 whitespace-pre-wrap">{profile().bio}</p>
        </Show>

        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
          <Stat testid="profile-stat-balance" label="Available" value={fmtRP(profile().rp_balance)} />
          <Stat testid="profile-stat-staked" label="Staked" value={fmtRP(profile().rp_staked)} />
          <Stat
            testid="profile-stat-reputation"
            label="Reputation"
            value={fmtRP(profile().total_reputation ?? (Number(profile().rp_balance) || 0) + (Number(profile().rp_staked) || 0))}
          />
        </div>

        <Show when={isOwn() && predictions().length > 0}>
          <div class="mb-4">
            <div class="text-bb-accent font-bold uppercase text-xs border-b border-bb-border pb-1 mb-2">[RECENT PREDICTIONS]</div>
            <For each={predictions()}>
              {(p) => (
                <div class="flex justify-between gap-3 py-1 border-b border-bb-border/20 text-xs">
                  <span class="truncate">{p.event || p.title || `EVENT ${p.event_id}`}</span>
                  <span class="text-bb-muted shrink-0 uppercase">{p.outcome || 'PENDING'}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show
          when={network()}
          fallback={
            <button
              type="button"
              data-testid="profile-load-network"
              onClick={loadNetwork}
              class="px-2 py-1 border border-bb-border text-bb-muted hover:text-bb-accent hover:border-bb-accent uppercase text-xs font-bold"
            >
              [LOAD FOLLOWERS / FOLLOWING]
            </button>
          }
        >
          <div class="grid md:grid-cols-2 gap-4">
            <For each={[['FOLLOWERS', network().followers], ['FOLLOWING', network().following]]}>
              {([label, rows]) => (
                <div>
                  <div class="text-bb-accent font-bold uppercase text-xs border-b border-bb-border pb-1 mb-2">[{label}: {rows.length}]</div>
                  <Show when={rows.length > 0} fallback={<div class="text-bb-muted text-xs">NONE</div>}>
                    <For each={rows}>
                      {(row) => (
                        <button
                          type="button"
                          class="block w-full text-left py-1 border-b border-bb-border/20 text-xs hover:bg-white/5"
                          onClick={() => { window.location.hash = `#user/${row.id || row.user_id}`; }}
                        >
                          <span class="font-bold">@{row.username}</span>
                          <Show when={row.accuracy_percent != null}>
                            <span class="text-bb-muted ml-2">{row.accuracy_percent}%</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
```

- [ ] **Step 4: Register both routes**

In `registry.js` add:

```js
  profile: {
    title: 'PROFILE',
    component: lazy(() => import('./ProfileView'))
  },
  user: {
    title: 'PROFILE',
    hidden: true, // reached via #user/:id links, not the palette
    component: lazy(() => import('./ProfileView'))
  },
```

In `TerminalApp.jsx`, filter hidden entries out of the palette actions:
`...Object.entries(TERMINAL_VIEWS).filter(([, view]) => !view.hidden).map(...)` (keep the rest of the mapping unchanged).

- [ ] **Step 5: Run to green, then regressions**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-profile.spec.js tests/e2e/terminal-views.spec.js
```

- [ ] **Step 6: Commit** — `feat(terminal): native profile view (own + other user, follow/network)`

---

### Task 2: NOTIFICATIONS view

**Files:**
- Create: `frontend-solid/src/components/terminal/views/NotificationsView.jsx`
- Modify: `frontend-solid/src/components/terminal/views/registry.js` (add `notifications`)
- Test: `tests/e2e/terminal-notifications.spec.js`

**Interfaces:**
- Consumes: `getNotifications({limit, offset})`, `getUnreadNotificationCount()` → `{count}`, `markNotificationRead(id)`, `markAllNotificationsRead()`, `deleteNotification(id)` (named exports); `registerSocketEventHandler('notification', handler)` from `services/socket` for live prepend (dedupe by id; payload may be `{type:'new', notification}` or `{notification}` or a bare notification — unwrap defensively; ignore `{type:'unreadCountUpdate'}` for the list, use its `count` for the counter).
- Produces: registry key `notifications` (title `NOTIFICATIONS`).
- Item fields: `id`, `type`, `actor_username`, `actor_id`, `target_type`, `target_id`, `target_content`, `created_at`, `read`. Clicking a `user`-type row → `#user/{actor_id}`; other types have no terminal post-detail yet → non-navigating row (Phase 3+).

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-notifications.spec.js
// Terminal notifications view: list renders, mark-all clears unread badge.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, provisionTier, apiFetch, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('notifications list + mark all read', async ({ page }) => {
  const a = await createUser('tnotif1a'); // viewer
  const b = await createUser('tnotif1b'); // actor
  created.push(a, b);
  provisionTier(a);
  provisionTier(b);

  // Seed: a posts once; b likes it -> a gets a 'like' notification.
  const post = await apiFetch('/api/posts', {
    method: 'POST', token: a.token,
    body: JSON.stringify({ content: 'terminal notifications seed post' })
  });
  expect([200, 201]).toContain(post.response.status);
  const postId = post.body?.id || post.body?.post?.id;
  expect(postId).toBeTruthy();
  const like = await apiFetch(`/api/posts/${postId}/like`, { method: 'POST', token: b.token });
  expect([200, 201]).toContain(like.response.status);

  await page.addInitScript((t) => localStorage.setItem('token', t), a.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#notifications`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="notifications"]');
  await expect(view).toBeVisible({ timeout: 15000 });

  const rows = view.locator('[data-testid="notification-row"]');
  await expect(rows.first()).toBeVisible({ timeout: 10000 });
  await expect(view.locator('[data-testid="notifications-unread"]')).toContainText(/[1-9]/);

  await view.locator('[data-testid="notifications-mark-all"]').click();
  await expect(view.locator('[data-testid="notifications-unread"]')).toContainText('0', { timeout: 10000 });
});
```

- [ ] **Step 2: RED run**
- [ ] **Step 3: Implement NotificationsView**

```jsx
// frontend-solid/src/components/terminal/views/NotificationsView.jsx
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import {
  deleteNotification,
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead
} from '../../../services/api';
import { registerSocketEventHandler } from '../../../services/socket';

const PAGE = 20;

const unwrap = (payload) => {
  if (!payload) return null;
  if (payload.notification) return payload.notification;
  if (payload.type === 'unreadCountUpdate') return null;
  return payload.id != null ? payload : null;
};

const actionText = (n) => {
  const who = n.actor_username || 'SOMEONE';
  const map = {
    like: 'LIKED YOUR POST',
    comment: 'COMMENTED ON YOUR POST',
    reply: 'REPLIED TO YOU',
    follow: 'FOLLOWED YOU',
    mention: 'MENTIONED YOU'
  };
  return `@${who} ${map[n.type] || 'SENT A NOTIFICATION'}`;
};

export default function NotificationsView() {
  const [items, setItems] = createSignal([]);
  const [unread, setUnread] = createSignal(0);
  const [hasMore, setHasMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  const normalize = (v) => Array.isArray(v) ? v : (v?.items || v?.notifications || []);

  const load = async (reset) => {
    if (loading()) return;
    setLoading(true);
    setError('');
    try {
      const offset = reset ? 0 : items().length;
      const rows = normalize(await getNotifications({ limit: PAGE, offset }));
      setItems(reset ? rows : (prev => {
        const seen = new Set(prev.map(i => String(i.id)));
        return [...prev, ...rows.filter(r => !seen.has(String(r.id)))];
      })(items()));
      setHasMore(rows.length >= PAGE);
      const c = await getUnreadNotificationCount().catch(() => null);
      setUnread(Number(c?.count ?? items().filter(i => !i.read).length) || 0);
    } catch (e) {
      setError(e?.message || 'FAILED TO LOAD NOTIFICATIONS');
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    load(true);
    const off = registerSocketEventHandler('notification', (payload) => {
      const n = unwrap(payload);
      if (payload?.type === 'unreadCountUpdate') { setUnread(Number(payload.count) || 0); return; }
      if (!n) return;
      setItems((prev) => prev.some(i => String(i.id) === String(n.id)) ? prev : [n, ...prev]);
      setUnread((u) => u + (n.read ? 0 : 1));
    });
    if (typeof off === 'function') onCleanup(off);
  });

  const markOne = async (n) => {
    if (n.read) return;
    setItems((prev) => prev.map(i => i.id === n.id ? { ...i, read: true } : i));
    setUnread((u) => Math.max(0, u - 1));
    try { await markNotificationRead(n.id); } catch { /* stays optimistic; refresh corrects */ }
  };

  const markAll = async () => {
    setItems((prev) => prev.map(i => ({ ...i, read: true })));
    setUnread(0);
    try { await markAllNotificationsRead(); } catch { load(true); }
  };

  const remove = async (n) => {
    setItems((prev) => prev.filter(i => i.id !== n.id));
    if (!n.read) setUnread((u) => Math.max(0, u - 1));
    try { await deleteNotification(n.id); } catch { load(true); }
  };

  const open = (n) => {
    markOne(n);
    if (n.type === 'follow' && n.actor_id) window.location.hash = `#user/${n.actor_id}`;
  };

  return (
    <div class="h-full flex flex-col font-mono text-sm">
      <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-bb-border bg-bb-panel text-xs">
        <span>UNREAD: <span data-testid="notifications-unread" class="text-bb-accent font-bold">{unread()}</span></span>
        <button
          type="button"
          data-testid="notifications-mark-all"
          onClick={markAll}
          class="px-2 py-0.5 border border-bb-border text-bb-muted hover:text-bb-accent hover:border-bb-accent uppercase font-bold"
        >
          [MARK ALL READ]
        </button>
      </div>

      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <Show when={error()}>
          <div class="p-3 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>
        </Show>
        <Show when={items().length > 0} fallback={
          <Show when={!loading()}>
            <div class="p-4 text-bb-muted">NO NOTIFICATIONS</div>
          </Show>
        }>
          <For each={items()}>
            {(n) => (
              <div
                data-testid="notification-row"
                class={`px-3 py-2 border-b border-bb-border/20 flex gap-3 items-baseline cursor-pointer hover:bg-white/5 ${n.read ? 'text-bb-muted' : 'text-bb-text'}`}
                onClick={() => open(n)}
              >
                <span class={`shrink-0 text-xxs ${n.read ? 'text-bb-muted' : 'text-bb-accent font-bold'}`}>{n.read ? '·' : '[N]'}</span>
                <span class="min-w-0 flex-1">
                  <span class={n.read ? '' : 'font-bold'}>{actionText(n)}</span>
                  <Show when={n.target_content}>
                    <span class="text-bb-muted"> // {String(n.target_content).slice(0, 120)}</span>
                  </Show>
                </span>
                <span class="shrink-0 text-xxs text-bb-muted">{n.created_at ? new Date(n.created_at).toLocaleString() : ''}</span>
                <button
                  type="button"
                  class="shrink-0 text-bb-muted hover:text-market-down text-xxs"
                  onClick={(e) => { e.stopPropagation(); remove(n); }}
                >
                  [X]
                </button>
              </div>
            )}
          </For>
        </Show>
        <Show when={loading()}>
          <div class="p-3 text-bb-muted animate-pulse text-xs">RUNNING QUERY...</div>
        </Show>
        <Show when={hasMore() && !loading()}>
          <button
            type="button"
            data-testid="notifications-load-more"
            class="w-full py-2 text-center text-bb-accent hover:bg-bb-accent/10 uppercase font-bold text-xs"
            onClick={() => load(false)}
          >
            LOAD MORE
          </button>
        </Show>
      </div>
    </div>
  );
}
```

Registry addition: `notifications: { title: 'NOTIFICATIONS', component: lazy(() => import('./NotificationsView')) }`.

NOTE: check `registerSocketEventHandler`'s return value in `services/socket.js` — if it does not return an unsubscribe function, register the handler anyway (harmless duplicate handling is prevented by the id-dedupe) and note it in your report.

- [ ] **Step 4: GREEN + regressions (`terminal-views.spec.js`)**
- [ ] **Step 5: Commit** — `feat(terminal): native notifications view (unread, mark-read, live socket prepend)`

---

### Task 3: SEARCH view

**Files:**
- Create: `frontend-solid/src/components/terminal/views/SearchView.jsx`
- Modify: `frontend-solid/src/components/terminal/views/registry.js` (add `search`)
- Test: `tests/e2e/terminal-search.spec.js`

**Interfaces:**
- Consumes: `api.users.search(query)` (via `import { api } from '../../../services/api'`) → array of `{id, username, is_following}`; `getPostsPage({cursor, limit})` for the POSTS tab; `followUser`/`unfollowUser`.
- KNOWN VAN QUIRK (replicate, don't fix): posts text-search does not filter server-side (`getPage` drops extra params). The terminal POSTS tab therefore filters the fetched page CLIENT-SIDE by `post.content.toLowerCase().includes(q)` and labels the tab `[POSTS (LOADED PAGES)]` so the limitation is honest. USERS search is real server search.
- Produces: registry key `search` (title `SEARCH`).

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-search.spec.js
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('user search finds a user and follows from results', async ({ page }) => {
  const a = await createUser('tsearch1a');
  const b = await createUser('tsearch1b');
  created.push(a, b);

  await page.addInitScript((t) => localStorage.setItem('token', t), a.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#search`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="search"]');
  await expect(view).toBeVisible({ timeout: 15000 });

  await view.locator('[data-testid="search-input"]').fill(b.username);
  const row = view.locator('[data-testid="search-user-row"]', { hasText: b.username });
  await expect(row).toBeVisible({ timeout: 10000 });

  await row.locator('[data-testid="search-follow"]').click();
  await expect(row.locator('[data-testid="search-follow"]')).toContainText('[UNFOLLOW]', { timeout: 10000 });
});
```

- [ ] **Step 2: RED run**
- [ ] **Step 3: Implement SearchView**

```jsx
// frontend-solid/src/components/terminal/views/SearchView.jsx
import { For, Show, createSignal, onCleanup } from 'solid-js';
import { api, followUser, getPostsPage, getPostsPaging, unfollowUser } from '../../../services/api';
import { isLoggedIn } from '../../../services/tokenService';

export default function SearchView() {
  const [tab, setTab] = createSignal('users'); // 'users' | 'posts'
  const [query, setQuery] = createSignal('');
  const [users, setUsers] = createSignal([]);
  const [posts, setPosts] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  let debounceTimer;
  let searchEpoch = 0;
  onCleanup(() => clearTimeout(debounceTimer));

  const run = async () => {
    const q = query().trim();
    const epoch = ++searchEpoch;
    if (!q) { setUsers([]); setPosts([]); return; }
    setLoading(true);
    setError('');
    try {
      if (tab() === 'users') {
        const rows = await api.users.search(q);
        if (epoch !== searchEpoch) return;
        setUsers(Array.isArray(rows) ? rows : []);
      } else {
        // Server-side post search does not exist (van parity quirk):
        // fetch the latest page and filter client-side.
        const page = getPostsPaging(await getPostsPage({ limit: 50 }));
        if (epoch !== searchEpoch) return;
        const needle = q.toLowerCase();
        setPosts(page.items.filter(p => String(p.content || '').toLowerCase().includes(needle)));
      }
    } catch (e) {
      if (epoch === searchEpoch) setError(e?.message || 'SEARCH FAILED');
    } finally {
      if (epoch === searchEpoch) setLoading(false);
    }
  };

  const onInput = (e) => {
    setQuery(e.currentTarget.value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 300);
  };

  const switchTab = (t) => { setTab(t); run(); };

  const toggleFollow = async (u) => {
    if (!isLoggedIn()) { window.location.hash = '#login'; return; }
    const wasFollowing = Boolean(u.is_following);
    setUsers((prev) => prev.map(x => x.id === u.id ? { ...x, is_following: !wasFollowing } : x));
    try {
      if (wasFollowing) await unfollowUser(u.id); else await followUser(u.id);
    } catch {
      setUsers((prev) => prev.map(x => x.id === u.id ? { ...x, is_following: wasFollowing } : x));
    }
  };

  return (
    <div class="h-full flex flex-col font-mono text-sm">
      <div class="shrink-0 border-b border-bb-border bg-bb-panel px-3 py-2 flex items-center gap-2">
        <span class="text-bb-accent font-bold">/</span>
        <input
          type="text"
          data-testid="search-input"
          class="flex-1 bg-transparent border-none outline-none text-bb-text placeholder-bb-muted"
          placeholder="SEARCH..."
          value={query()}
          onInput={onInput}
        />
      </div>
      <div class="shrink-0 flex border-b border-bb-border bg-bb-panel text-xs select-none">
        <button type="button" onClick={() => switchTab('users')} class={`px-4 py-2 border-r border-bb-border uppercase ${tab() === 'users' ? 'bg-bb-accent/15 text-bb-accent font-bold' : 'text-bb-muted hover:text-bb-text'}`}>[USERS]</button>
        <button type="button" onClick={() => switchTab('posts')} class={`px-4 py-2 border-r border-bb-border uppercase ${tab() === 'posts' ? 'bg-bb-accent/15 text-bb-accent font-bold' : 'text-bb-muted hover:text-bb-text'}`}>[POSTS (LOADED PAGES)]</button>
      </div>

      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <Show when={error()}>
          <div class="p-3 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>
        </Show>
        <Show when={loading()}>
          <div class="p-3 text-bb-muted animate-pulse text-xs">RUNNING QUERY...</div>
        </Show>
        <Show when={tab() === 'users'}>
          <Show when={users().length > 0} fallback={<Show when={!loading() && query().trim()}><div class="p-4 text-bb-muted">NO USERS FOUND</div></Show>}>
            <For each={users()}>
              {(u) => (
                <div data-testid="search-user-row" class="px-3 py-2 border-b border-bb-border/20 flex items-center justify-between gap-3 hover:bg-white/5">
                  <button type="button" class="font-bold text-left truncate hover:text-bb-accent" onClick={() => { window.location.hash = `#user/${u.id}`; }}>
                    @{u.username}
                  </button>
                  <button
                    type="button"
                    data-testid="search-follow"
                    onClick={() => toggleFollow(u)}
                    class="shrink-0 px-2 py-0.5 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase text-xxs font-bold"
                  >
                    {u.is_following ? '[UNFOLLOW]' : '[FOLLOW]'}
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>
        <Show when={tab() === 'posts'}>
          <Show when={posts().length > 0} fallback={<Show when={!loading() && query().trim()}><div class="p-4 text-bb-muted">NO MATCHES IN LOADED PAGES</div></Show>}>
            <For each={posts()}>
              {(p) => (
                <div class="px-3 py-2 border-b border-bb-border/20 text-xs">
                  <span class="text-bb-accent font-bold">@{p.username}</span>
                  <p class="text-bb-text whitespace-pre-wrap break-words mt-1">{p.content}</p>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
```

Registry addition: `search: { title: 'SEARCH', component: lazy(() => import('./SearchView')) }`.

- [ ] **Step 4: GREEN + regressions**
- [ ] **Step 5: Commit** — `feat(terminal): native search view (server user search, client post filter)`

---

### Task 4: Feed comments (expand + inline composer)

**Files:**
- Modify: `frontend-solid/src/components/FeedPanel.jsx` (PostItem gains comments)
- Test: `tests/e2e/terminal-feed-comments.spec.js`

**Interfaces:**
- Consumes: `getPostComments(postId)` (flat list; items may carry `replies` arrays — render recursively), `createComment(postId, content)` → new comment object. Both named exports.
- Produces: inside `PostItem`, a `[CMT:{n}]` toggle button (`data-testid="post-comments-toggle"`), a lazy-loaded comment list (`data-testid="comment-row"`), and an inline composer (`data-testid="comment-input"`, submit on Enter). `comment_count` updates locally after posting.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-feed-comments.spec.js
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, provisionTier, apiFetch, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('expand comments and add one inline', async ({ page }) => {
  const u = await createUser('tcmt1');
  created.push(u);
  provisionTier(u);

  const post = await apiFetch('/api/posts', {
    method: 'POST', token: u.token,
    body: JSON.stringify({ content: 'terminal comments seed post' })
  });
  const postId = post.body?.id || post.body?.post?.id;
  expect(postId).toBeTruthy();

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  const post0 = page.locator('[data-testid="feed-post"]', { hasText: 'terminal comments seed post' }).first();
  await expect(post0).toBeVisible({ timeout: 20000 });

  await post0.locator('[data-testid="post-comments-toggle"]').click();
  const input = post0.locator('[data-testid="comment-input"]');
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill('terminal inline comment');
  await input.press('Enter');

  await expect(post0.locator('[data-testid="comment-row"]', { hasText: 'terminal inline comment' }))
    .toBeVisible({ timeout: 10000 });
  await expect(post0.locator('[data-testid="post-comments-toggle"]')).toContainText('CMT:1');
});
```

- [ ] **Step 2: RED run**
- [ ] **Step 3: Implement in FeedPanel.jsx**

Add imports: `import { getPostComments, createComment } from "../services/api";` (merge into the existing api import line if present — FeedPanel already imports `{ api, ApiError }`; use `api.posts.getComments` / `api.posts.createComment` instead if you prefer a single import — pick one style and note it).

Add a `CommentItem` component (above `PostItem`):

```jsx
const CommentItem = (props) => (
    <div data-testid="comment-row" class="pl-3 border-l border-bb-border/40 py-1">
        <div class="flex justify-between items-baseline">
            <span class="font-bold text-bb-accent text-xxs">@{props.comment.username}</span>
            <span class="text-xxs text-bb-muted font-mono">
                {props.comment.created_at ? new Date(props.comment.created_at).toLocaleTimeString() : ''}
            </span>
        </div>
        <p class="text-bb-text text-xs break-words whitespace-pre-wrap">{props.comment.content}</p>
        <Show when={Array.isArray(props.comment.replies) && props.comment.replies.length > 0}>
            <For each={props.comment.replies}>
                {(reply) => <CommentItem comment={reply} />}
            </For>
        </Show>
    </div>
);
```

Extend `PostItem` with comment state and UI (inside the component):

```jsx
    const [showComments, setShowComments] = createSignal(false);
    const [comments, setComments] = createSignal([]);
    const [commentsLoaded, setCommentsLoaded] = createSignal(false);
    const [commentText, setCommentText] = createSignal("");
    const [commentBusy, setCommentBusy] = createSignal(false);
    const commentCount = () => Number(props.post.comment_count || 0) + comments().filter(c => c.__local).length;

    const toggleComments = async () => {
        const next = !showComments();
        setShowComments(next);
        if (next && !commentsLoaded()) {
            try {
                const rows = await getPostComments(props.post.id);
                setComments(Array.isArray(rows) ? rows : (rows?.comments || []));
            } catch (err) {
                console.error("Failed to load comments", err);
            } finally {
                setCommentsLoaded(true);
            }
        }
    };

    const submitComment = async () => {
        const text = commentText().trim();
        if (!text || commentBusy()) return;
        setCommentBusy(true);
        try {
            const created = await createComment(props.post.id, text);
            setComments((prev) => [...prev, { ...created, __local: true }]);
            setCommentText("");
        } catch (err) {
            console.error("Failed to comment", err);
        } finally {
            setCommentBusy(false);
        }
    };
```

Wire `createSignal` import (already imported in FeedPanel) and render below the existing footer row inside PostItem's root div:

```jsx
            <div class="flex gap-2 text-xxs font-mono mt-1">
                <button
                    type="button"
                    data-testid="post-comments-toggle"
                    class="text-bb-muted hover:text-bb-accent uppercase"
                    onClick={toggleComments}
                >
                    [CMT:{commentCount()}]
                </button>
            </div>
            <Show when={showComments()}>
                <div class="mt-2">
                    <Show when={commentsLoaded()} fallback={<div class="text-xxs text-bb-muted animate-pulse">LOADING COMMENTS...</div>}>
                        <For each={comments()}>
                            {(c) => <CommentItem comment={c} />}
                        </For>
                        <Show when={comments().length === 0}>
                            <div class="text-xxs text-bb-muted">NO COMMENTS</div>
                        </Show>
                    </Show>
                    <input
                        type="text"
                        data-testid="comment-input"
                        class="w-full mt-1 bg-black/20 border border-bb-border text-bb-text font-mono text-xs p-1 focus:outline-none focus:border-bb-accent placeholder-bb-muted/50"
                        placeholder="// REPLY..."
                        value={commentText()}
                        disabled={commentBusy()}
                        onInput={(e) => setCommentText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitComment(); } }}
                    />
                </div>
            </Show>
```

Adjust the count display: `[CMT:{commentCount()}]` must show `CMT:1` after the first inline comment even when `props.post.comment_count` is 0 — the `__local` counting above handles this.

- [ ] **Step 4: GREEN + feed regression (`terminal-feed-pagination.spec.js`)**
- [ ] **Step 5: Commit** — `feat(terminal): inline comments in feed pane (lazy load + composer)`

---

### Task 5: Feed images + reposts

**Files:**
- Modify: `frontend-solid/src/components/FeedPanel.jsx`
- Test: extend `tests/e2e/terminal-feed-comments.spec.js` (rename NOT needed; add one test)

**Interfaces:**
- Consumes: `requestBlob(path)` named export (`/attachments/${id}` → Blob; render via `URL.createObjectURL`, revoke on cleanup); post fields `image_attachment_id`, `reposted_post` (`{username, content, created_at}`), `repost_count`, `reposted_by_user`; `api.posts.create(content, image_attachment_id, image_url, repost_id)` for the repost action (NOTE: the van PostItem calls an unimported `feedStore.createPost` here — that is a live van bug; do NOT copy it. `feedStore.createPost(content, image_attachment_id, image_url, repost_id)` DOES exist in the terminal feedStore and adds the repost to the top of the feed — use it).
- Produces: `[RT:{n}]` repost button (`data-testid="post-repost"`), embedded original rendering (`data-testid="repost-embed"`), attachment image rendering.

- [ ] **Step 1: Failing e2e test** (append)

```js
test('repost embeds the original in the feed', async ({ page }) => {
  const u = await createUser('trt1');
  created.push(u);
  provisionTier(u);

  const post = await apiFetch('/api/posts', {
    method: 'POST', token: u.token,
    body: JSON.stringify({ content: 'terminal repost original' })
  });
  expect(post.body?.id || post.body?.post?.id).toBeTruthy();

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  const original = page.locator('[data-testid="feed-post"]', { hasText: 'terminal repost original' }).first();
  await expect(original).toBeVisible({ timeout: 20000 });

  await original.locator('[data-testid="post-repost"]').click();
  await expect(page.locator('[data-testid="repost-embed"]', { hasText: 'terminal repost original' }).first())
    .toBeVisible({ timeout: 10000 });
});
```

- [ ] **Step 2: RED run**
- [ ] **Step 3: Implement in FeedPanel PostItem**

Image (add near the content `<p>`):

```jsx
    const [attachmentSrc, setAttachmentSrc] = createSignal(null);
    createEffect(() => {
        const id = props.post.image_attachment_id;
        if (!id) { setAttachmentSrc(null); return; }
        let revoked = false;
        let url = null;
        requestBlob(`/attachments/${id}`)
            .then((blob) => {
                if (revoked) return;
                url = URL.createObjectURL(blob);
                setAttachmentSrc(url);
            })
            .catch(() => setAttachmentSrc(null));
        onCleanup(() => {
            revoked = true;
            if (url) URL.revokeObjectURL(url);
        });
    });
```

```jsx
            <Show when={attachmentSrc()}>
                <img src={attachmentSrc()} alt="" class="max-w-full max-h-64 border border-bb-border my-1" />
            </Show>
```

Repost embed (after the content `<p>`):

```jsx
            <Show when={props.post.reposted_post}>
                <div data-testid="repost-embed" class="border border-bb-border/60 bg-black/20 p-2 my-1 text-xs">
                    <span class="text-bb-accent font-bold text-xxs">RT @{props.post.reposted_post.username}</span>
                    <p class="text-bb-text break-words whitespace-pre-wrap">{props.post.reposted_post.content}</p>
                </div>
            </Show>
```

Repost action (in the footer button row next to LIKE):

```jsx
                    <button
                        type="button"
                        data-testid="post-repost"
                        class={`cursor-pointer hover:text-white transition-colors uppercase ${props.post.reposted_by_user ? 'text-market-neutral font-bold' : 'text-bb-muted'}`}
                        disabled={props.post.is_temp}
                        onClick={() => feedStore.createPost('', null, null, props.post.id).catch((err) => console.error('Repost failed', err))}
                    >
                        [RT:{props.post.repost_count || 0}]
                    </button>
```

Imports to add: `requestBlob` from `../services/api`, `createEffect`, `onCleanup` from solid-js (merge with existing import).

- [ ] **Step 4: GREEN + full feed spec**
- [ ] **Step 5: Commit** — `feat(terminal): images and reposts in feed pane`

---

### Task 6: Feed source parity (following-feed + discover fallback + ranking)

**Files:**
- Modify: `frontend-solid/src/store/feedStore.js`
- Modify: `frontend-solid/src/components/FeedPanel.jsx` (discover banner + FOLLOW button, ranked rendering)
- Test: `tests/e2e/terminal-feed-source.spec.js`

**Interfaces:**
- Consumes: `getFeedPage({cursor, limit})`, `getPostsPage({cursor, limit})`, `getPostsPaging`, `api.discover.feed()` → `{items}`, `getFeedWeights()` → `{weights}`, `rankPosts(posts, weights)` from `frontend-solid/src/lib/feedRanking` (verify export name before use), `followUser`.
- Produces: `feedStore.state` gains `usingFeed: boolean` (init from `getToken()` presence at fetch time), `discoverMode: boolean`. Behavior parity with van HomePage:
  1. Logged-in reset load → `getFeedPage`; on 401/403 error message downgrade `usingFeed=false` and retry once with `getPostsPage`.
  2. Reset feed load returning 0 items → `api.discover.feed()`; non-empty → `discoverMode=true`, posts=discover items, `hasMore=false`.
  3. FeedPanel renders `rankPosts(posts, weights)` via `createMemo` (weights fetched once on mount, null-safe no-op).
  4. Discover banner `[DISCOVER MODE] TOP PREDICTORS IN YOUR TOPICS` with per-post `[FOLLOW]` button → `followUser(post.user_id)` then `feedStore.loadPosts()` (clears discover mode when the feed has content).
- The epoch guard stays; all new paths respect it.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-feed-source.spec.js
// A fresh user follows nobody: their /feed is empty, so the terminal feed
// must fall back to discover mode (or, if discover is also empty, show the
// explicit empty state — never a blank pane).
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('fresh user gets discover fallback or explicit empty state', async ({ page }) => {
  const u = await createUser('tsrc1');
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  const banner = page.locator('[data-testid="feed-discover-banner"]');
  const empty = page.locator('[data-testid="feed-empty"]');
  const posts = page.locator('[data-testid="feed-post"]');
  await expect(banner.or(empty).or(posts.first())).toBeVisible({ timeout: 20000 });
  // If discover mode is active, posts must carry FOLLOW buttons.
  if (await banner.isVisible()) {
    await expect(page.locator('[data-testid="discover-follow"]').first()).toBeVisible();
  }
});
```

- [ ] **Step 2: RED run** — currently the terminal feed uses `/posts` (public firehose), so for a fresh user neither `feed-discover-banner` nor `feed-empty` exists; the test can only pass via the posts branch IF the public feed is non-empty — make the RED check honest: run it and confirm it passes-or-fails for the right reason; the REAL red assertion is `feed-empty`/`feed-discover-banner` testids not existing. Run:

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-feed-source.spec.js
```

If it passes via the posts branch (public posts exist), still proceed — the implementation changes the source to `/feed`, after which the fresh-user path MUST hit banner-or-empty; re-run after implementing and confirm the banner/empty branch is what renders (assert by checking which locator matched, log it in your report).

- [ ] **Step 3: feedStore changes**

In `fetchPage`, replace the single `getPage` call:

```js
        const cursor = reset ? null : state.nextCursor;
        let response;
        let usingFeed = state.usingFeed;
        if (usingFeed) {
            try {
                response = await api.posts.getFeedPage({ cursor, limit: PAGE_LIMIT });
            } catch (err) {
                const msg = String(err?.message || '');
                if (reset && (msg.includes('401') || msg.includes('403'))) {
                    usingFeed = false;
                    response = await api.posts.getPage({ cursor, limit: PAGE_LIMIT });
                } else {
                    throw err;
                }
            }
        } else {
            response = await api.posts.getPage({ cursor, limit: PAGE_LIMIT });
        }
        if (epoch !== fetchEpoch) return;
        const paging = getPostsPaging(response);

        // Empty following-feed on reset: discover fallback (top predictors).
        if (reset && usingFeed && paging.items.length === 0) {
            try {
                const discover = await api.discover.feed();
                if (epoch !== fetchEpoch) return;
                const items = Array.isArray(discover?.items) ? discover.items : [];
                if (items.length > 0) {
                    setState({
                        posts: items, usingFeed, discoverMode: true,
                        hasMore: false, nextCursor: null,
                        loading: false, loadingMore: false
                    });
                    return;
                }
            } catch (err) {
                console.error('Discover fallback failed', err);
            }
        }
```

State shape gains `usingFeed: true` / `discoverMode: false` defaults; on every fetch entry set `usingFeed` initial value: in `loadPosts` (reset), set `setState('usingFeed', Boolean(getToken()))` before fetching; normal set path writes `{ usingFeed, discoverMode: reset ? false : state.discoverMode, ... }`. `clear()` resets both (and still bumps `fetchEpoch`).

- [ ] **Step 4: FeedPanel changes**

- Fetch weights once: `const [weights, setWeights] = createSignal(null); onMount(() => { getFeedWeights().then(w => setWeights(w?.weights || w || null)).catch(() => {}); });`
- Verify the ranking helper: `grep -n "export" frontend-solid/src/lib/feedRanking.js` — use its actual export (van uses `rankPosts(posts, weights)`); render `<For each={rankedPosts()}>` where `const rankedPosts = createMemo(() => rankPosts(feedStore.state.posts, weights()));` (null weights = original order).
- Banner + follow button:

```jsx
                <Show when={feedStore.state.discoverMode}>
                    <div data-testid="feed-discover-banner" class="px-2 py-1 text-xxs text-bb-tmux border-b border-bb-border/40 bg-bb-panel/60 uppercase">
                        [DISCOVER MODE] TOP PREDICTORS IN YOUR TOPICS — FOLLOW TO BUILD YOUR FEED
                    </div>
                </Show>
```

In PostItem footer (only when `feedStore.state.discoverMode`):

```jsx
                    <Show when={feedStore.state.discoverMode}>
                        <button
                            type="button"
                            data-testid="discover-follow"
                            class="text-bb-accent hover:text-white uppercase"
                            onClick={async () => {
                                try { await followUser(props.post.user_id); feedStore.loadPosts(); } catch (err) { console.error('Follow failed', err); }
                            }}
                        >
                            [FOLLOW]
                        </button>
                    </Show>
```

- Empty state (when not loading, zero posts, no discover): `<div data-testid="feed-empty" class="p-4 text-bb-muted font-mono text-xs">FEED EMPTY // FOLLOW USERS OR CHECK BACK LATER</div>`

- [ ] **Step 5: GREEN + full feed specs + views regression**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-feed-source.spec.js tests/e2e/terminal-feed-pagination.spec.js tests/e2e/terminal-feed-comments.spec.js tests/e2e/terminal-views.spec.js
```

NOTE: terminal-feed-pagination seeds 25 posts for one fresh user — with the source now `/feed`, a fresh user's feed contains their OWN posts only if the backend includes self-posts in /feed. VERIFY: if that spec breaks because /feed excludes own posts, have the seed user follow themselves being impossible — instead create a second user who follows the seeder (`apiFetch('/api/users/:id/follow', {method:'POST', token: viewer.token})`) and view as that second user. Adapt the spec minimally and explain in the report.

- [ ] **Step 6: Commit** — `feat(terminal): van feed-source parity (following feed, discover fallback, ranking weights)`

---

### Task 7: Weekly-question slot + `#predictions/:id` deep link

**Files:**
- Modify: `frontend-solid/src/store/marketStore.js` (add `ensureMarket(id)`)
- Modify: `frontend-solid/src/components/TerminalApp.jsx` (`applyRoute` handles `predictions/:id`)
- Modify: `frontend-solid/src/components/MarketPanel.jsx` (weekly slot above the search row)
- Test: `tests/e2e/terminal-weekly.spec.js`

**Interfaces:**
- Consumes: `api.weekly.getUserStatus(userId)` → `{success, assignment: {event_id, event_title, weekly_assignment_completed}, isCompleted}`; `api.events.getById(eventId)`; `getCurrentUserId` from `services/auth`.
- Produces: `marketStore.ensureMarket(id)` — if `id` already in `state.markets`, just `selectMarket(id)`; else `api.events.getById(id)` and PREPEND to `state.markets` then select (do not touch `total`/`hasMore`; guard with try/catch and no-op on failure). `applyRoute` in TerminalApp: for route `predictions` with a numeric param, additionally call `marketStore.ensureMarket(Number(param))`.
- Weekly slot: `[WEEKLY]` row shown only when an open, uncompleted assignment with `event_id` exists: `WEEKLY ASSIGNMENT // {event_title}` + `[STAKE NOW]` button → `window.location.hash = '#predictions/' + event_id`.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-weekly.spec.js
// #predictions/:id deep link must select that market even if it is not on page 1.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('predictions deep link selects the market', async ({ page }) => {
  const u = await createUser('twk1');
  created.push(u);
  // Pick a real event that is NOT in the first 100 by the default ordering.
  const row = dbQuery(`SELECT id, title FROM events ORDER BY id DESC LIMIT 1;`);
  const [eventId] = row.split('|');
  expect(Number(eventId)).toBeGreaterThan(0);

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#predictions/${eventId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  // The order-book detail shows the selected market (desktop viewport default).
  await expect(page.getByText('ORDER BOOK // DEPTH')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="market-detail-title"]')).not.toHaveText('', { timeout: 15000 });
});
```

Also add `data-testid="market-detail-title"` to the `<h2>` in `MarketDetail.jsx` as part of this task (tiny addition, note it in the commit).

- [ ] **Step 2: RED run**
- [ ] **Step 3: Implement `ensureMarket`**

```js
const ensureMarket = async (id) => {
    if (!Number.isFinite(id)) return;
    if (state.markets.some(m => m.id === id)) {
        selectMarket(id);
        return;
    }
    try {
        const market = await api.events.getById(id);
        if (!market?.id) return;
        setState('markets', (prev) => prev.some(m => m.id === market.id) ? prev : [market, ...prev]);
        selectMarket(market.id);
    } catch (err) {
        console.error('ensureMarket failed', err);
    }
};
```

Export from the store object. In `TerminalApp.applyRoute`, inside the `PANE_ROUTES[route]` branch:

```js
    if (PANE_ROUTES[route]) {
      setActivePane(PANE_ROUTES[route]);
      setActiveView(null);
      if (route === 'predictions' && param) {
        marketStore.ensureMarket(Number(param));
      }
    }
```

(`marketStore` is already imported in TerminalApp.)

- [ ] **Step 4: Weekly slot in MarketPanel**

```jsx
const WeeklySlot = () => {
    const [assignment, setAssignment] = createSignal(null);
    onMount(async () => {
        try {
            const userId = getCurrentUserId();
            if (!userId) return;
            const status = await api.weekly.getUserStatus(userId);
            const a = status?.assignment;
            if (status?.success && a?.event_id && !status?.isCompleted && !a?.weekly_assignment_completed) {
                setAssignment(a);
            }
        } catch { /* slot simply doesn't render */ }
    });
    return (
        <Show when={assignment()}>
            <div data-testid="weekly-slot" class="shrink-0 flex items-center justify-between gap-2 px-2 py-1 border-b border-bb-border bg-bb-tmux/10 font-mono text-xs">
                <span class="min-w-0 truncate">
                    <span class="text-bb-tmux font-bold">[WEEKLY]</span>{' '}
                    {assignment().event_title || `EVENT ${assignment().event_id}`}
                </span>
                <button
                    type="button"
                    data-testid="weekly-stake"
                    class="shrink-0 px-2 py-0.5 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 uppercase font-bold"
                    onClick={() => { window.location.hash = `#predictions/${assignment().event_id}`; }}
                >
                    [STAKE NOW]
                </button>
            </div>
        </Show>
    );
};
```

Imports: `onMount` from solid-js, `api` already imported? MarketPanel imports `marketStore` only — add `import { api } from "../services/api";` and `import { getCurrentUserId } from "../services/auth";`. Render `<WeeklySlot />` directly above `<MarketSearchRow />`.

- [ ] **Step 5: GREEN + market regressions**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-weekly.spec.js tests/e2e/terminal-market-pagination.spec.js
```

- [ ] **Step 6: Commit** — `feat(terminal): weekly assignment slot + #predictions/:id deep link (ensureMarket)`

---

### Task 8: Phase-2 regression gate

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test \
  tests/e2e/terminal-views.spec.js tests/e2e/terminal-profile.spec.js \
  tests/e2e/terminal-notifications.spec.js tests/e2e/terminal-search.spec.js \
  tests/e2e/terminal-feed-comments.spec.js tests/e2e/terminal-feed-source.spec.js \
  tests/e2e/terminal-feed-pagination.spec.js tests/e2e/terminal-market-pagination.spec.js \
  tests/e2e/terminal-weekly.spec.js tests/e2e/terminal-skin-back.spec.js \
  tests/e2e/predictions-pagination.spec.js tests/e2e/predictions-tabs.spec.js
```

- [ ] **Step 2: Production build** (`cd frontend-solid && npm run build`)
- [ ] **Step 3: Smoke screenshots** (desktop + mobile: profile view, notifications view, search view, feed with comments open, weekly slot) — eyeball for layout breakage; leave files in scratchpad.
- [ ] **Step 4: Report** — do NOT merge/push; Phase 3 (SETTINGS + GROUPS + NETWORK) is planned separately.
