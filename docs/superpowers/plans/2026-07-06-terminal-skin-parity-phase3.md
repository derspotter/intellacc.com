# Terminal Skin Parity — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminal-native SETTINGS, GROUPS, GROUP, and NETWORK views; repair the app-wide server-side skin-preference sync; extract the terminal PostItem for reuse in group feeds.

**Architecture:** Extends the Phase 1/2 view registry with four new lazy views. Group feeds reuse the extracted terminal `PostItem`. Group chat uses the existing socket helpers (`joinGroupChat`/`leaveGroupChat`). Network is a dependency-free table over `api.network.getGraph()` + `lib/graphFilters` (NO three.js). One deliberate api.js amendment: add the missing `api.users.getUiPreferences`/`updateUiPreferences` wrappers (backend `GET/PUT /users/me/preferences` exists; every current caller throws and is silently swallowed).

**Tech Stack:** SolidJS + Tailwind bb-* tokens, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-05-terminal-skin-parity-design.md`

## Global Constraints

- Branch `worktree-bloomberg-tmux-skin`; worktree `.claude/worktrees/bloomberg-tmux-skin`. No van components/CSS in terminal code; bb-* tokens, UPPERCASE mono copy, `[BRACKET]` chrome, no emojis.
- View registry contract (Phase 1/2): `TERMINAL_VIEWS[key] = { title, component: lazy(...), hidden? }`; components receive `props.param`; never destructure props; close via hash `#home`.
- `getCurrentUserId` from `services/auth` (sync), never from services/api.
- Request-guard convention: epoch counters on any async whose stale response could clobber newer state; discard on success AND catch paths.
- api.js may be modified ONLY in Task 1 (the two users wrappers). No backend changes anywhere in this phase.
- E2E: helpers from `tests/e2e/helpers/solidMessaging.js` (`createUser` async, `provisionTier` SYNC, `apiFetch`, `dbQuery`, `cleanupUsers`); `?skin=terminal` forcing; never touch real `registration_approval_tokens` rows.
- KNOWN BACKEND BUG: ~10 rapid POSTs by one user wedge the API — space seeded posts ≥200ms, keep per-user seeds < 10.
- KNOWN-RED: `tests/e2e/terminal-feed-pagination.spec.js` fails live until the branch's backend getFeed fix deploys — do NOT run it in verification steps.
- Test env: worktree Vite dev server on port 4175 (already running); Playwright from worktree root with `SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175`.
- TDD per task; commit per task with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Repair server-side skin-preference sync

**Files:**
- Modify: `frontend-solid/src/services/api.js` (add two methods to the `api.users` object)
- Test: `tests/e2e/skin-preference-sync.spec.js`

**Interfaces:**
- Produces: `api.users.getUiPreferences()` → `GET /users/me/preferences` → `{skin}`; `api.users.updateUiPreferences(skin)` → `PUT /users/me/preferences` body `{skin}` → `{skin}`. The existing top-level exports `getUiPreferences`/`updateUiPreferences` (api.js ~1212-1214) and ALL existing callers (`skinProvider.syncSkinWithServer`, `SkinPreferenceSettings`, TerminalApp's `switchToVan`) start working with no further changes.

- [ ] **Step 1: Write the failing e2e test**

```js
// tests/e2e/skin-preference-sync.spec.js
// The backend has GET/PUT /users/me/preferences but the frontend wrappers
// were missing, so skin choice never synced to the account. After the fix,
// a server-persisted "terminal" preference must apply on a clean visit
// with no ?skin= override and no localStorage.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, apiFetch, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('server-persisted skin preference applies on visit', async ({ page }) => {
  const u = await createUser('tskin1');
  created.push(u);

  const put = await apiFetch('/api/users/me/preferences', {
    method: 'PUT', token: u.token, body: JSON.stringify({ skin: 'terminal' })
  });
  expect(put.response.status).toBe(200);
  expect(put.body.skin).toBe('terminal');

  // Clean visit: token only, no ?skin=, no stored local skin.
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
});

test('terminal [VAN] button persists the preference server-side', async ({ page }) => {
  const u = await createUser('tskin2');
  created.push(u);

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  await page.getByRole('button', { name: '[VAN]' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'van', { timeout: 10000 });

  await expect.poll(async () => {
    const res = await apiFetch('/api/users/me/preferences', { token: u.token });
    return res.body?.skin;
  }, { timeout: 10000 }).toBe('van');
});
```

- [ ] **Step 2: RED run** — first test fails (server PUT works, but `syncSkinWithServer` throws internally so the skin never applies); second test's poll times out (`skin` stays null).

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/skin-preference-sync.spec.js
```

- [ ] **Step 3: Add the wrappers**

In `frontend-solid/src/services/api.js`, inside the `users: { ... }` object (near `getFeedWeights`):

```js
    getUiPreferences: () =>
      request('/users/me/preferences'),

    updateUiPreferences: (skin) =>
      request('/users/me/preferences', { method: 'PUT', body: { skin } }),
```

- [ ] **Step 4: GREEN + regressions** (`terminal-skin-back.spec.js` — the [VAN] flow; `terminal-views.spec.js`)
- [ ] **Step 5: Commit** — `fix(skins): wire the missing ui-preferences client methods — server skin sync was dead code`

---

### Task 2: Extract terminal PostItem (+CommentItem) for reuse

**Files:**
- Create: `frontend-solid/src/components/terminal/PostItem.jsx`
- Modify: `frontend-solid/src/components/FeedPanel.jsx` (import instead of defining)
- Test: existing specs only (pure refactor)

**Interfaces:**
- Produces: `PostItem` (default export) with the exact current props: `post` (required). It internally uses `feedStore` for like/repost/discover-follow as today — Task 4's group feed needs like/comments to work on group posts too, so ALSO add an optional `disableFeedStore` boolean prop: when true, the repost button and discover-follow button are hidden (group posts aren't repostable into the group context via feedStore), and like falls back to calling `api.posts.likePost/unlikePost` directly with local signal state instead of feedStore mutations. `CommentItem` stays internal to the new file.
- Everything else (comments lazy-load, images, embeds) is store-independent already.

- [ ] **Step 1: Move code** — relocate `CommentItem` and `PostItem` (and only them) from `FeedPanel.jsx` into the new file; move the imports they need (`getPostComments`, `createComment`, `requestBlob`, `followUser`, solid primitives, `feedStore`, `api`). Add the `disableFeedStore` prop logic:

```jsx
    const localLike = async () => {
        const wasLiked = Boolean(props.post.liked_by_user);
        setLocalLiked(!wasLiked);
        try {
            if (wasLiked) await api.posts.unlikePost(props.post.id);
            else await api.posts.likePost(props.post.id);
        } catch {
            setLocalLiked(wasLiked);
        }
    };
```

with `const [localLiked, setLocalLiked] = createSignal(null)` and the LIKE button reading `localLiked() ?? props.post.liked_by_user` and count `(props.post.like_count || 0) + (localLiked() === true && !props.post.liked_by_user ? 1 : localLiked() === false && props.post.liked_by_user ? -1 : 0)` when `props.disableFeedStore`, else the existing feedStore path unchanged. Hide `[RT:...]` and `[FOLLOW]` (discover) buttons when `props.disableFeedStore`.

- [ ] **Step 2: FeedPanel imports it** — `import PostItem from "./terminal/PostItem";` and drop the moved code; keep `PostComposer`, `FeedPanel` itself, discover banner, LOAD MORE untouched.
- [ ] **Step 3: Verify (refactor gate)**

```bash
cd frontend-solid && npm run build && cd .. && SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-feed-comments.spec.js tests/e2e/terminal-feed-source.spec.js tests/e2e/terminal-views.spec.js
```
Expected: build OK, 6 passed.

- [ ] **Step 4: Commit** — `refactor(terminal): extract PostItem/CommentItem for group-feed reuse`

---

### Task 3: SETTINGS view

**Files:**
- Create: `frontend-solid/src/components/terminal/views/SettingsView.jsx`
- Modify: `frontend-solid/src/components/terminal/views/registry.js` (add `settings`)
- Test: `tests/e2e/terminal-settings.spec.js`

**Interfaces:**
- Consumes: `setSkin`, `getActiveSkin`, `VALID_SKINS` from `services/skinProvider`; `updateUiPreferences` named export (works after Task 1); `getFeedWeights`/`saveFeedWeights` named exports (`{weights:{accuracy,followers,likes,views}}` / raw object PUT); `KEYS`, `redistribute` from `lib/feedRanking` (NOTE: `LABEL` is NOT exported — define locally); `api.users.changePassword(oldPassword, newPassword)`; `api.verification.getStatus()` → `{current_tier,...}`; `api.users.deleteAccount(password)`; push: `isPushSupported`, `getSubscriptionState`, `getPreferences`, `updatePreferences`, `subscribeToPush`, `unsubscribeFromPush` from `services/pushService`.
- Produces: registry key `settings` (title `SETTINGS`). Sections (in order): `[SKIN]`, `[FEED MIX]`, `[NOTIFICATIONS]`, `[VERIFICATION]`, `[PASSWORD]`, `[DANGER ZONE]`.
- DEFERRED to Phase 4 (document in the view with a `[MORE IN VAN SETTINGS]` note row): passkeys, device manager, vault, API keys, AI-flagged (admin). These carry E2EE machinery out of scope here.

Section behaviors (each its own small component in the same file):
- **SKIN**: two buttons `[VAN]` `[TERMINAL]`, active one highlighted (`getActiveSkin()`); click → `setSkin(k)` + if `isAuthenticated()` `updateUiPreferences(k).catch(() => {})`. `data-testid="settings-skin-van"` / `settings-skin-terminal"`.
- **FEED MIX**: load via `getFeedWeights()` (default `{accuracy:25,followers:25,likes:25,views:25}` on failure); one row per `KEYS` entry with a `range` input (0–100) + `[LOCK]` toggle; on input → `setWeights(redistribute(weights(), locks(), key, Number(value)))`; `[SAVE]` button → `saveFeedWeights(weights())`, disabled while saving, `SAVED // FEED MIX` confirmation row. `data-testid="settings-feedmix-save"`.
- **NOTIFICATIONS**: if `!isPushSupported()` → `PUSH NOT SUPPORTED IN THIS BROWSER`; else show subscription state and `[ENABLE PUSH]`/`[DISABLE PUSH]` via `subscribeToPush`/`unsubscribeFromPush`; when subscribed, three toggles (`push_replies`, `push_follows`, `push_messages`) each sending the full merged prefs object via `updatePreferences`.
- **VERIFICATION**: `api.verification.getStatus()` → render `TIER: {current_tier}` (string/number as returned) + link-style row `[VERIFY EMAIL]` if tier 0 (reuses the send-verification API only if trivially available — otherwise just display; do not build the full verification flow here, it exists in FeedPanel's banner).
- **PASSWORD**: two password inputs + `[CHANGE PASSWORD]` → `api.users.changePassword(oldPw, newPw)`; success/error inline rows; clear inputs on success.
- **DANGER ZONE**: red-bordered section; input requiring the literal text `DELETE`, a password input, and `[DELETE ACCOUNT]` calling `api.users.deleteAccount(password)`; on success clear token via `import("../../../services/tokenService").then(s => s.clearToken())` and set hash `#home`. Button disabled until confirm text matches.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-settings.spec.js
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, apiFetch, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

async function openSettings(page, u) {
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#settings`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="settings"]');
  await expect(view).toBeVisible({ timeout: 15000 });
  return view;
}

test('feed mix saves to the server', async ({ page }) => {
  const u = await createUser('tset1');
  created.push(u);
  const view = await openSettings(page, u);

  // Nudge the first slider, then save.
  const slider = view.locator('input[type="range"]').first();
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await view.locator('[data-testid="settings-feedmix-save"]').click();
  await expect(view).toContainText('SAVED // FEED MIX', { timeout: 10000 });

  const res = await apiFetch('/api/users/me/feed-weights', { token: u.token });
  const w = res.body?.weights;
  expect(w).toBeTruthy();
  expect(w.accuracy + w.followers + w.likes + w.views).toBe(100);
});

test('skin section switches to van and persists', async ({ page }) => {
  const u = await createUser('tset2');
  created.push(u);
  const view = await openSettings(page, u);

  await view.locator('[data-testid="settings-skin-van"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'van', { timeout: 10000 });
  await expect.poll(async () => {
    const res = await apiFetch('/api/users/me/preferences', { token: u.token });
    return res.body?.skin;
  }, { timeout: 10000 }).toBe('van');
});
```

- [ ] **Step 2: RED run**
- [ ] **Step 3: Implement SettingsView + registry entry** (sections per the interface block; each section a `Section` wrapper `div` with `[TITLE]` header row, bb-panel background, one component per section in the same file)
- [ ] **Step 4: GREEN + `terminal-views.spec.js` regression**
- [ ] **Step 5: Commit** — `feat(terminal): native settings view (skin, feed mix, push, verification, password, danger zone)`

---

### Task 4: GROUPS view (browse/search/create/join)

**Files:**
- Create: `frontend-solid/src/components/terminal/views/GroupsView.jsx`
- Modify: `frontend-solid/src/components/terminal/views/registry.js` (add `groups`)
- Test: `tests/e2e/terminal-groups.spec.js`

**Interfaces:**
- Consumes: `listGroups({topic, sort})` → `{groups}`; `searchGroups(q, topic)` → `{groups}`; `createGroup({name, description, topic_id})` → `{group}` (403 → "NEEDS VERIFIED ACCOUNT" banner); `joinGroup(id)`/`leaveGroup(id)` → `{is_member, member_count}`; `api.topics.list()` → `{topics}`.
- Produces: registry key `groups` (title `GROUPS`). Group rows navigate to `#group/{slug}` (Task 5's view). Layout: topic filter row (ALL + topics), sort toggle `[MEMBERS]`/`[RECENT]`, search input (300ms debounce, epoch-guarded — same pattern as SearchView), dense rows `NAME | TOPIC | MEMBERS | [JOIN]/[LEAVE]`, `[+ NEW GROUP]` opening an inline create form (name/description/topic select).
- Group row fields: `id`, `slug`, `name`, `topic_name`, `member_count`, `is_member`.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-groups.spec.js
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
const createdGroups = [];
test.afterAll(async () => {
  for (const id of createdGroups) {
    try { dbQuery(`DELETE FROM community_group_members WHERE group_id = ${id}; DELETE FROM community_groups WHERE id = ${id};`); } catch {}
  }
  await cleanupUsers(created);
});

test('groups view lists groups and creates one', async ({ page }) => {
  const u = await createUser('tgrp1');
  created.push(u);
  // Group creation needs a verified account; raise tier directly.
  dbQuery(`UPDATE users SET verification_tier = GREATEST(verification_tier, 2) WHERE id = ${u.id};`);

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#groups`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="groups"]');
  await expect(view).toBeVisible({ timeout: 15000 });

  await view.locator('[data-testid="groups-new"]').click();
  const name = `TERM TEST GROUP ${Date.now()}`;
  await view.locator('[data-testid="group-create-name"]').fill(name);
  await view.locator('[data-testid="group-create-submit"]').click();

  // Creation navigates to the group page route; Task 5 renders it. Until
  // then the hash change is the observable contract.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('#group/');
  const gid = dbQuery(`SELECT id FROM community_groups WHERE name = '${name.replace(/'/g, "''")}' LIMIT 1;`).split('\n')[0];
  if (gid) createdGroups.push(Number(gid));
});
```

NOTE: verify the actual table names before relying on the cleanup SQL (`\dt` via dbQuery: expect `community_groups` / `community_group_members`; adapt if they differ — check `backend/migrations` or the groups controller). Record what you found in the report.

- [ ] **Step 2: RED run**
- [ ] **Step 3: Implement GroupsView + registry** (sections per interface block; join/leave buttons update the row from the response; create form 403 → inline `NEEDS VERIFIED ACCOUNT // SEE SETTINGS` banner)
- [ ] **Step 4: GREEN + `terminal-views.spec.js` regression**
- [ ] **Step 5: Commit** — `feat(terminal): native groups browser (list, search, create, join)`

---

### Task 5: GROUP view (`#group/:slug` — feed, chat, markets, members)

**Files:**
- Create: `frontend-solid/src/components/terminal/views/GroupView.jsx`
- Modify: `frontend-solid/src/components/terminal/views/registry.js` (add `group`, hidden)
- Test: `tests/e2e/terminal-group-page.spec.js`

**Interfaces:**
- Consumes: `getGroup(slug)` → `{group: {id, slug, name, topic_name, description, member_count, is_member, is_owner}}` (404 → `GROUP NOT FOUND`); `joinGroup`/`leaveGroup`; `getGroupPosts(slug, {limit: 30})` → `{posts}` (NOT items); `postToGroup(groupId, content)` (member-gated); `removeGroupPost(groupId, postId)` (owner-gated); `getGroupMessages(slug, {limit: 50})` → `{messages}`; `sendGroupMessage(groupId, content)` (sender relies on the socket echo — no local append); `joinGroupChat(groupId, handler)`/`leaveGroupChat(groupId, handler)` from `services/socket` (dedupe incoming by id; leave on cleanup AND on tab switch away); `getGroupMarkets(slug)` → `{markets: [{event_id, title, outcome, market_prob, closing_date}]}`; `pinGroupMarket(groupId, eventId)`/`unpinGroupMarket(groupId, eventId)` (owner); `getEvents(text)` for the owner's pin-search; `getGroupMembers(slug)` → `{members: [{user_id, username, role}]}`; `removeGroupMember(groupId, userId)` → `{member_count}` (owner, non-owner rows).
- Consumes from Task 2: terminal `PostItem` with `disableFeedStore` for group posts.
- Produces: registry key `group` (title `GROUP`, `hidden: true`); `props.param` = slug. Tabs `[FEED] [CHAT] [MARKETS] [MEMBERS]` (same tab style as LeaderboardView). Market rows navigate to `#predictions/{event_id}` (deep link from Phase 2). Member rows navigate to `#user/{user_id}`.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-group-page.spec.js
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, provisionTier, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
const createdGroups = [];
test.afterAll(async () => {
  for (const id of createdGroups) {
    try { dbQuery(`DELETE FROM community_group_members WHERE group_id = ${id}; DELETE FROM community_groups WHERE id = ${id};`); } catch {}
  }
  await cleanupUsers(created);
});

test('group page: feed post + members tab', async ({ page }) => {
  const u = await createUser('tgpg1');
  created.push(u);
  provisionTier(u);
  dbQuery(`UPDATE users SET verification_tier = GREATEST(verification_tier, 2) WHERE id = ${u.id};`);

  // Seed a group owned by the user directly (adapt SQL to the real schema —
  // check the groups controller/migration; slug must be unique).
  const slug = `term-e2e-${Date.now()}`;
  const gid = dbQuery(`
    INSERT INTO community_groups (name, slug, description, topic_id, owner_user_id, created_at, updated_at)
    VALUES ('Term E2E ${Date.now()}', '${slug}', 'e2e', (SELECT id FROM topics LIMIT 1), ${u.id}, NOW(), NOW())
    RETURNING id;`).split('\n')[0];
  createdGroups.push(Number(gid));
  dbQuery(`INSERT INTO community_group_members (group_id, user_id, role, created_at) VALUES (${gid}, ${u.id}, 'owner', NOW());`);

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#group/${slug}`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="group"]');
  await expect(view).toBeVisible({ timeout: 15000 });
  await expect(view).toContainText('Term E2E');

  // Post in the group feed.
  await view.locator('[data-testid="group-post-input"]').fill('terminal group feed post');
  await view.locator('[data-testid="group-post-submit"]').click();
  await expect(view.locator('[data-testid="feed-post"]', { hasText: 'terminal group feed post' }))
    .toBeVisible({ timeout: 10000 });

  // Members tab shows the owner.
  await view.getByRole('button', { name: '[MEMBERS]' }).click();
  await expect(view.locator('[data-testid="group-member-row"]', { hasText: u.username }))
    .toBeVisible({ timeout: 10000 });
});
```

NOTE: the seed SQL column names are a best guess — verify against `backend/migrations`/`communityGroupsController` FIRST and adapt (report what the real schema is). If direct seeding proves brittle, create the group via the API instead (`POST /groups` with the tier-2 user) and keep only the cleanup SQL.

- [ ] **Step 2: RED run**
- [ ] **Step 3: Implement GroupView + registry** — header (name/topic/members + `[JOIN]/[LEAVE]` + `[REPORT]` for non-owners via `reportGroup(id, reason)` with a one-line reason input), tabs per interface block. Chat tab: socket join on tab enter, leave on tab exit and `onCleanup`; messages deduped by id; input gated on membership. Feed tab: composer gated on membership; posts rendered with `PostItem` (`disableFeedStore`); owner sees `[REMOVE]` per post. Markets tab: rows clickable → `#predictions/{event_id}`; owner search-to-pin box (uses `getEvents(text)`, shows top 10, `[PIN]` buttons) + `[UNPIN]`. Members tab: rows → `#user/{user_id}`, owner sees `[REMOVE]` on non-owner rows (updates member_count from response).
- [ ] **Step 4: GREEN + regressions** (`terminal-groups.spec.js`, `terminal-views.spec.js`)
- [ ] **Step 5: Commit** — `feat(terminal): native group page (feed, live chat, markets, members)`

---

### Task 6: NETWORK view

**Files:**
- Create: `frontend-solid/src/components/terminal/views/NetworkView.jsx`
- Modify: `frontend-solid/src/components/terminal/views/registry.js` (add `network`)
- Test: `tests/e2e/terminal-network.spec.js`

**Interfaces:**
- Consumes: `api.network.getGraph()` → `{nodes: [{id, username, followers, accuracy_percent}], edges}` (no named export — import `{ api }`); `applyGraphFilters(graph, {hideIsolates, largestClusterOnly, maxNodes})` from `lib/graphFilters` (pure, no heavy deps); `followUser`/`unfollowUser`/`getFollowingStatus`; `getCurrentUserId` from services/auth.
- Produces: registry key `network` (title `NETWORK`). NO three.js / SocialGraph3D import anywhere. Layout: filter row (`[HIDE ISOLATES]` toggle, `[LARGEST CLUSTER]` toggle, max-nodes select 50/100/250), search input (client-side username prefix match), sortable dense table `USER | FOLLOWERS | ACC% | DEGREE | [FOLLOW]` (degree = edge count touching the node, computed client-side once per graph load). Rows navigate to `#user/{id}`; follow button epoch/row-guarded like SearchView's.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-network.spec.js
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('network view renders the graph as a table', async ({ page }) => {
  const u = await createUser('tnet1');
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#network`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="network"]');
  await expect(view).toBeVisible({ timeout: 15000 });
  // Rows or the explicit empty state — never blank.
  await expect(view.locator('[data-testid="network-row"], [data-testid="network-empty"]').first())
    .toBeVisible({ timeout: 15000 });
  // The 3D bundle must not load: assert no three.js chunk was requested.
  const threeRequests = [];
  page.on('request', (r) => { if (/three|SocialGraph3D/i.test(r.url())) threeRequests.push(r.url()); });
  await page.waitForTimeout(1000);
  expect(threeRequests).toHaveLength(0);
});
```

(Register the `page.on('request')` listener BEFORE `page.goto` — reorder in the actual spec; the above sketch notes the intent.)

- [ ] **Step 2: RED run**
- [ ] **Step 3: Implement NetworkView + registry** per interface block.
- [ ] **Step 4: GREEN + `terminal-views.spec.js` regression + build** (`npm run build` — confirms no accidental three.js import in the new chunk graph)
- [ ] **Step 5: Commit** — `feat(terminal): native network view (graph as sortable table, no 3D deps)`

---

### Task 7: Phase-3 regression gate

**Files:** none (verification only)

- [ ] **Step 1: Full suite** (all terminal specs + van regression, MINUS known-red `terminal-feed-pagination.spec.js`):

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test \
  tests/e2e/terminal-views.spec.js tests/e2e/terminal-profile.spec.js \
  tests/e2e/terminal-notifications.spec.js tests/e2e/terminal-search.spec.js \
  tests/e2e/terminal-feed-comments.spec.js tests/e2e/terminal-feed-source.spec.js \
  tests/e2e/terminal-market-pagination.spec.js tests/e2e/terminal-weekly.spec.js \
  tests/e2e/terminal-settings.spec.js tests/e2e/terminal-groups.spec.js \
  tests/e2e/terminal-group-page.spec.js tests/e2e/terminal-network.spec.js \
  tests/e2e/skin-preference-sync.spec.js tests/e2e/terminal-skin-back.spec.js \
  tests/e2e/predictions-pagination.spec.js tests/e2e/predictions-tabs.spec.js
```

- [ ] **Step 2: Production build.**
- [ ] **Step 3: Smoke screenshots** (settings, groups, group page tabs, network — desktop + one mobile) to scratchpad; eyeball.
- [ ] **Step 4: Report** — no merge/push; Phase 4 (ANALYTICS + ADMIN + auth screens + settings-advanced) planned separately.
