# Terminal Skin Parity — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the terminal (Bloomberg/tmux) skin a routed full-screen view system with a native LEADERBOARD view, a live RP balance in the top bar, server-paginated + searchable markets, paginated feed, and eliminate the double-mounted market list.

**Architecture:** The three panes stay the home surface. A hash-driven view registry opens terminal-native full-screen views over the panes (`#leaderboard` first; later phases add profile/settings/etc.). Stores move from load-everything to server pagination using APIs that already exist on the base branch (`api.events.getPage`, `api.posts.getPage`). All UI is Tailwind bb-* terminal style; no van components or CSS.

**Tech Stack:** SolidJS + Vite, Tailwind (bb-* tokens), Playwright e2e (host), existing Express backend (no backend changes).

**Spec:** `docs/superpowers/specs/2026-07-05-terminal-skin-parity-design.md`

## Global Constraints

- Branch: `worktree-bloomberg-tmux-skin` (worktree at `.claude/worktrees/bloomberg-tmux-skin`), based on `predictions-declutter-tabs`. Do NOT rebase onto master.
- No van page components or van CSS classes in terminal code. Terminal UI uses Tailwind bb-* tokens and `[BRACKET]` chrome only.
- No new backend endpoints. Frontend consumes existing `api.events.getPage({search, limit, offset})` → `{items, total, hasMore}` and `api.posts.getPage({cursor, limit})` → normalize with `getPostsPaging()`.
- All copy in terminal UI is UPPERCASE mono style, no emojis (repo rule: no emojis in predictions UI).
- E2E tests follow `tests/e2e/helpers/solidMessaging.js` patterns (`createUser`, `cleanupUsers`, `SOLID_URL`, `?skin=terminal` forcing).
- Test server: run the worktree's Vite dev server on port **4175** (prod runs on 4174 — never touch it):
  `cd frontend-solid && VITE_API_PROXY_TARGET=http://127.0.0.1:3000 VITE_SERVER_PORT=4175 npx vite`
  Run Playwright with `SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175`.
- Backend on port 3000 is the production backend — tests create disposable users via helpers and MUST clean them up (`cleanupUsers`).
- Commit after every task (conventional commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).

---

### Task 0: Worktree environment setup + baseline

**Files:** none created (setup only)

- [ ] **Step 1: Install frontend deps in the worktree**

```bash
cd /var/opt/docker/intellacc.com/.claude/worktrees/bloomberg-tmux-skin/frontend-solid
npm install
```

Expected: completes without errors (openmls wasm pkg is vendored at `../shared/openmls-pkg`, no build step needed).

- [ ] **Step 2: Start the dev server on 4175 (background)**

```bash
cd /var/opt/docker/intellacc.com/.claude/worktrees/bloomberg-tmux-skin/frontend-solid
VITE_API_PROXY_TARGET=http://127.0.0.1:3000 VITE_SERVER_PORT=4175 npx vite
```

Run in background. Verify: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4175/` → `200`.

- [ ] **Step 3: Baseline e2e — existing terminal spec passes**

```bash
cd /var/opt/docker/intellacc.com/.claude/worktrees/bloomberg-tmux-skin
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-skin-back.spec.js
```

Expected: 1 passed. If it fails, STOP and report — do not proceed on a dirty baseline.

- [ ] **Step 4: Baseline build**

```bash
cd frontend-solid && npm run build
```

Expected: build succeeds.

---

### Task 1: Shared routes module

**Files:**
- Create: `frontend-solid/src/services/routes.js`
- Modify: `frontend-solid/src/VanApp.jsx` (delete local ROUTES/normalizeHashPath/sanitizeRoute, import them; rewrite `parseRoute` body to use `parseHashRoute`)

**Interfaces:**
- Produces: `ROUTES` (object), `AUTH_ROUTES` (array), `NOT_FOUND_ROUTE` (string `'notFound'`), `normalizeHashPath(raw) → string`, `sanitizeRoute(raw) → string`, `parseHashRoute(hashValue) → { page, param }`. Task 2 consumes `normalizeHashPath`.

- [ ] **Step 1: Create the module**

```js
// frontend-solid/src/services/routes.js
// Single source of truth for hash routes, shared by the van and terminal
// skins so deep links mean the same thing in both.

export const ROUTES = {
  home: 'home',
  login: 'login',
  signup: 'signup',
  'forgot-password': 'forgot-password',
  'reset-password': 'reset-password',
  profile: 'profile',
  user: 'user',
  predictions: 'predictions',
  analytics: 'analytics',
  network: 'network',
  groups: 'groups',
  group: 'group',
  messages: 'messages',
  notifications: 'notifications',
  settings: 'settings',
  'verify-email': 'verify-email',
  search: 'search',
  ...(import.meta.env.DEV ? { __harness: '__harness' } : {})
};

export const NOT_FOUND_ROUTE = 'notFound';

export const AUTH_ROUTES = [
  'login',
  'signup',
  'forgot-password',
  'reset-password',
  'verify-email'
];

export const normalizeHashPath = (raw) => {
  const value = (raw || '').replace(/^#/, '').trim();
  if (!value || value.startsWith('?')) {
    return 'home';
  }

  const [path] = value.split('?');
  const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');

  return normalized || 'home';
};

export const sanitizeRoute = (raw) => {
  const route = normalizeHashPath(raw).split('/')[0];
  return ROUTES[route] || NOT_FOUND_ROUTE;
};

export const parseHashRoute = (hashValue) => {
  const value = normalizeHashPath(hashValue);
  const [route, param] = value.split('/');

  if (route === 'user' && !param) {
    return { page: NOT_FOUND_ROUTE, param: null };
  }

  return { page: ROUTES[route] || NOT_FOUND_ROUTE, param: param || null };
};
```

- [ ] **Step 2: Refactor VanApp.jsx to consume it**

In `frontend-solid/src/VanApp.jsx`:
- Delete the local `ROUTES`, `NOT_FOUND_ROUTE`, `AUTH_ROUTES`, `normalizeHashPath`, `sanitizeRoute` definitions (lines ~25–71).
- Add `import { AUTH_ROUTES, NOT_FOUND_ROUTE, parseHashRoute, sanitizeRoute } from './services/routes';`
- Replace the body of the component's `parseRoute` with:

```js
  const parseRoute = (hashValue) => {
    const { page: nextPage, param } = parseHashRoute(hashValue);
    setPage(nextPage);
    setRouteParam(param);
  };
```

(Note: `parseHashRoute` returns `param: null` for the no-param `user` route, matching the old behavior.)

- [ ] **Step 3: Build to verify no unused/missing symbol errors**

```bash
cd frontend-solid && npm run build
```

Expected: success.

- [ ] **Step 4: Run van + terminal routing e2e regression**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-skin-back.spec.js tests/e2e/predictions-tabs.spec.js
```

Expected: all pass (terminal-skin-back exercises both skins; predictions-tabs exercises van hash routing).

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/services/routes.js frontend-solid/src/VanApp.jsx
git commit -m "refactor(routing): extract shared hash-route module for both skins"
```

---

### Task 2: Terminal view shell + LEADERBOARD view

**Files:**
- Create: `frontend-solid/src/components/terminal/views/registry.js`
- Create: `frontend-solid/src/components/terminal/views/LeaderboardView.jsx`
- Create: `frontend-solid/src/components/terminal/TerminalViewHost.jsx`
- Modify: `frontend-solid/src/components/TerminalApp.jsx`
- Test: `tests/e2e/terminal-views.spec.js`

**Interfaces:**
- Consumes: `normalizeHashPath` from `services/routes` (Task 1).
- Produces: `TERMINAL_VIEWS` registry — `{ [routeKey]: { title: string, component: lazy Solid component receiving props.param } }`. Later phases add views by extending this object only. TerminalApp gains signal `activeView() → { key, param } | null`.

- [ ] **Step 1: Write the failing e2e test**

```js
// tests/e2e/terminal-views.spec.js
// Terminal skin full-screen views: hash-driven, palette-openable, ESC-closable.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

async function loginTerminal(page, prefix) {
  const u = await createUser(prefix);
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
  return u;
}

test('leaderboard view opens via hash and closes with ESC', async ({ page }) => {
  await loginTerminal(page, 'tview1');

  await page.evaluate(() => { window.location.hash = '#leaderboard'; });
  const view = page.locator('[data-view="leaderboard"]');
  await expect(view).toBeVisible({ timeout: 10000 });
  await expect(view).toContainText('[VIEW] LEADERBOARD');
  // Global tab renders rows or the explicit empty state — never blank.
  await expect(view.locator('[data-testid="leaderboard-rows"], [data-testid="leaderboard-empty"]').first())
    .toBeVisible({ timeout: 10000 });

  await page.keyboard.press('Escape');
  await expect(view).not.toBeVisible();
  expect(new URL(page.url()).hash).toBe('#home');
});

test('command palette opens the leaderboard view', async ({ page }) => {
  await loginTerminal(page, 'tview2');

  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Type a command...').fill('leader');
  await page.getByRole('button', { name: /Open Leaderboard/i }).click();

  await expect(page.locator('[data-view="leaderboard"]')).toBeVisible({ timeout: 10000 });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-views.spec.js
```

Expected: FAIL — `[data-view="leaderboard"]` never appears.

- [ ] **Step 3: Create the view registry**

```js
// frontend-solid/src/components/terminal/views/registry.js
import { lazy } from 'solid-js';

// Terminal-native full-screen views, keyed by hash route segment.
// Later parity phases (profile, settings, ...) extend this map only.
export const TERMINAL_VIEWS = {
  leaderboard: {
    title: 'LEADERBOARD',
    component: lazy(() => import('./LeaderboardView'))
  }
};
```

- [ ] **Step 4: Create LeaderboardView**

```jsx
// frontend-solid/src/components/terminal/views/LeaderboardView.jsx
import { createEffect, createSignal, For, Show } from 'solid-js';
import {
  getLeaderboardFollowers,
  getLeaderboardFollowing,
  getLeaderboardGlobal,
  getLeaderboardNetwork,
  getLeaderboardUserRank
} from '../../../services/api';
import { getCurrentUserId, isAuthenticated } from '../../../services/auth';

const TABS = [
  { key: 'global', label: 'GLOBAL' },
  { key: 'followers', label: 'FOLLOWERS' },
  { key: 'following', label: 'FOLLOWING' },
  { key: 'network', label: 'NETWORK' }
];

const FETCHERS = {
  global: getLeaderboardGlobal,
  followers: getLeaderboardFollowers,
  following: getLeaderboardFollowing,
  network: getLeaderboardNetwork
};

const fmtRP = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
};

export default function LeaderboardView() {
  const [tab, setTab] = createSignal('global');
  const [rows, setRows] = createSignal([]);
  const [myRank, setMyRank] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  const isMe = (userId) => {
    const current = getCurrentUserId();
    return current != null && String(userId) === String(current);
  };

  createEffect(() => {
    const t = tab();
    setLoading(true);
    setError('');
    Promise.all([
      FETCHERS[t](25),
      isAuthenticated() ? getLeaderboardUserRank().catch(() => null) : Promise.resolve(null)
    ])
      .then(([entries, rank]) => {
        setRows(Array.isArray(entries?.leaderboard) ? entries.leaderboard : (entries || []));
        setMyRank(rank || null);
      })
      .catch((e) => {
        setError(e?.message || 'FAILED TO LOAD LEADERBOARD');
        setRows([]);
      })
      .finally(() => setLoading(false));
  });

  return (
    <div class="h-full flex flex-col font-mono text-sm">
      <div class="shrink-0 flex border-b border-bb-border bg-bb-panel text-xs select-none">
        <For each={TABS}>
          {(t) => (
            <button
              type="button"
              onClick={() => setTab(t.key)}
              class={`px-4 py-2 border-r border-bb-border uppercase ${
                tab() === t.key
                  ? 'bg-bb-accent/15 text-bb-accent font-bold'
                  : 'text-bb-muted hover:text-bb-text hover:bg-white/5'
              }`}
            >
              [{t.label}]
            </button>
          )}
        </For>
        <Show when={myRank()}>
          <div class="ml-auto px-4 py-2 text-bb-tmux">
            YOUR RANK: #{myRank().rank || '--'} // {fmtRP(myRank().total_reputation)} RP
          </div>
        </Show>
      </div>

      <div class="grid grid-cols-[6ch_minmax(0,1fr)_max-content_max-content] px-3 py-1 border-b border-bb-border text-bb-muted bg-bb-panel text-xs">
        <div>RANK</div>
        <div>USER</div>
        <div class="px-3 text-right">PRED</div>
        <div class="text-right">REP (RP)</div>
      </div>

      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <Show when={!loading()} fallback={<div class="p-4 text-bb-muted animate-pulse">RUNNING QUERY...</div>}>
          <Show when={!error()} fallback={<div class="p-4 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>}>
            <Show
              when={rows().length > 0}
              fallback={<div data-testid="leaderboard-empty" class="p-4 text-bb-muted">NO RANKED USERS</div>}
            >
              <div data-testid="leaderboard-rows">
                <For each={rows()}>
                  {(entry, index) => (
                    <div
                      class={`grid grid-cols-[6ch_minmax(0,1fr)_max-content_max-content] px-3 py-1 border-b border-bb-border/20 text-xs ${
                        isMe(entry.user_id) ? 'bg-bb-accent/10 text-bb-accent' : index() % 2 === 0 ? 'bg-bb-bg' : 'bg-[#0a0a0a]'
                      }`}
                    >
                      <div class="text-bb-muted">#{index() + 1}</div>
                      <div class="truncate font-bold">@{entry.username || `USER ${entry.user_id}`}</div>
                      <div class="px-3 text-right text-bb-muted">{entry.total_predictions ?? '--'}</div>
                      <div class="text-right text-market-up font-bold">{fmtRP(entry.total_reputation)}</div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create TerminalViewHost**

```jsx
// frontend-solid/src/components/terminal/TerminalViewHost.jsx
import { Show, Suspense } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { TERMINAL_VIEWS } from './views/registry';

// Full-screen layer over the panes (below the tmux top bar). Closing always
// routes back to #home so the hash stays the single source of truth.
export const closeTerminalView = () => {
  window.location.hash = '#home';
};

export const TerminalViewHost = (props) => {
  const view = () => TERMINAL_VIEWS[props.viewKey];

  return (
    <Show when={view()}>
      <div class="absolute inset-0 z-30 bg-bb-bg flex flex-col" data-view={props.viewKey}>
        <div class="shrink-0 h-8 flex items-center justify-between px-3 bg-bb-panel border-b border-bb-border font-mono text-xs select-none">
          <span class="text-bb-accent font-bold">[VIEW] {view().title}</span>
          <button
            type="button"
            class="text-bb-muted hover:text-bb-accent cursor-pointer"
            onClick={closeTerminalView}
          >
            [X] ESC TO CLOSE
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          <Suspense fallback={<div class="p-4 text-bb-muted font-mono animate-pulse">LOADING VIEW...</div>}>
            <Dynamic component={view().component} param={props.param} />
          </Suspense>
        </div>
      </div>
    </Show>
  );
};
```

- [ ] **Step 6: Wire hash routing + palette + ESC into TerminalApp.jsx**

In `frontend-solid/src/components/TerminalApp.jsx`:

Add imports:

```js
import { normalizeHashPath } from "../services/routes";
import { TerminalViewHost, closeTerminalView } from "./terminal/TerminalViewHost";
import { TERMINAL_VIEWS } from "./terminal/views/registry";
```

Add route state next to `activePane` (inside `App`):

```js
  // Hash-driven navigation. Pane routes focus a pane; registry routes open a
  // full-screen view; anything else leaves the panes as-is.
  const PANE_ROUTES = { home: 1, predictions: 2, messages: 3 };
  const [activeView, setActiveView] = createSignal(null); // { key, param } | null

  const applyRoute = () => {
    const value = normalizeHashPath(window.location.hash);
    const [route, param] = value.split('/');
    if (PANE_ROUTES[route]) {
      setActivePane(PANE_ROUTES[route]);
      setActiveView(null);
    } else if (TERMINAL_VIEWS[route]) {
      setActiveView({ key: route, param: param || null });
    }
  };

  // Focus a pane immediately AND sync the hash. Setting only the hash would
  // no-op when it already equals the target (no hashchange event fires).
  const goPane = (route) => {
    setActivePane(PANE_ROUTES[route]);
    setActiveView(null);
    window.location.hash = `#${route}`;
  };
```

In `onMount`, before the keydown listener registration, add:

```js
    applyRoute();
    window.addEventListener('hashchange', applyRoute);
    onCleanup(() => window.removeEventListener('hashchange', applyRoute));
```

In the keydown handler's Escape branch, close an open view (insert after the `showHelp()` check, before the `isInput` blur):

```js
            if (activeView()) {
                closeTerminalView();
                return;
            }
```

Extend `allActions` (palette) with one entry per registered view. Replace the current `allActions` array items for panes so pane focus also updates the hash, and append the views:

```js
  const allActions = [
    { id: 'feed', label: 'Focus Feed', shortcut: '1', action: () => goPane('home') },
    { id: 'market', label: 'Focus Market', shortcut: '2', action: () => goPane('predictions') },
    { id: 'chat', label: 'Focus Chat', shortcut: '3', action: () => goPane('messages') },
    ...Object.entries(TERMINAL_VIEWS).map(([key, view]) => ({
      id: `view-${key}`,
      label: `Open ${view.title.charAt(0) + view.title.slice(1).toLowerCase()}`,
      shortcut: '',
      action: () => { window.location.hash = `#${key}`; }
    })),
    { id: 'help', label: 'Toggle Help', shortcut: '?', action: () => setShowHelp(prev => !prev) },
    { id: 'skin-van', label: 'Switch to Van Skin', shortcut: '', action: switchToVan },
    { id: 'logout', label: 'Logout', shortcut: '', action: () => import("../services/tokenService").then(s => s.clearToken()) }
  ];
```

Also update the numeric hotkeys (`1`/`2`/`3` in the keydown handler) to route via hash for consistency:

```js
            if (e.key === '1') goPane('home');
            if (e.key === '2') goPane('predictions');
            if (e.key === '3') goPane('messages');
```

Mount the host inside the panes container (the `div` with `class="flex-1 min-h-0 relative z-10"`), after `<ThreePaneLayout ... />`:

```jsx
        <Show when={activeView()}>
          <TerminalViewHost viewKey={activeView().key} param={activeView().param} />
        </Show>
```

- [ ] **Step 7: Run the e2e test until green**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-views.spec.js
```

Expected: 2 passed.

- [ ] **Step 8: Regression — existing terminal spec + build**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-skin-back.spec.js
cd frontend-solid && npm run build
```

Expected: pass, build OK.

- [ ] **Step 9: Commit**

```bash
git add frontend-solid/src/components/terminal tests/e2e/terminal-views.spec.js frontend-solid/src/components/TerminalApp.jsx
git commit -m "feat(terminal): hash-routed full-screen views + native leaderboard"
```

---

### Task 3: RP balance in the tmux top bar

**Files:**
- Create: `frontend-solid/src/components/terminal/TerminalRPBalance.jsx`
- Modify: `frontend-solid/src/components/TerminalApp.jsx` (mount in top bar)
- Modify: `frontend-solid/src/components/market/MarketDetail.jsx` (dispatch refresh event after trade fill)
- Test: extend `tests/e2e/terminal-views.spec.js`

**Interfaces:**
- Consumes: `getCurrentUser()` → `{ rp_balance, rp_staked, ... }`, `getLeaderboardUserRank()` → `{ rank, total_reputation, ... }` from `services/api`; `isLoggedIn` from tokenService.
- Produces: window event contract `rp-balance-refresh` — any component that changes RP dispatches `window.dispatchEvent(new CustomEvent('rp-balance-refresh'))`. Later phases reuse this.

- [ ] **Step 1: Add the failing e2e test** (append to `tests/e2e/terminal-views.spec.js`)

```js
test('RP readout shows in top bar and opens leaderboard', async ({ page }) => {
  await loginTerminal(page, 'tview3');

  const rp = page.locator('[data-testid="rp-readout"]');
  await expect(rp).toBeVisible({ timeout: 10000 });
  await expect(rp).toContainText(/RP:\d/);

  await rp.click();
  await expect(page.locator('[data-view="leaderboard"]')).toBeVisible({ timeout: 10000 });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-views.spec.js -g "RP readout"
```

Expected: FAIL — `[data-testid="rp-readout"]` not found.

- [ ] **Step 3: Create TerminalRPBalance**

```jsx
// frontend-solid/src/components/terminal/TerminalRPBalance.jsx
import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { getCurrentUser, getLeaderboardUserRank } from '../../services/api';
import { isLoggedIn } from '../../services/tokenService';

export default function TerminalRPBalance() {
  const [data, setData] = createSignal(null);

  const load = async () => {
    if (!isLoggedIn()) {
      setData(null);
      return;
    }
    const [user, rank] = await Promise.allSettled([getCurrentUser(), getLeaderboardUserRank()]);
    const u = user.status === 'fulfilled' ? user.value : null;
    const r = rank.status === 'fulfilled' ? rank.value : null;
    if (!u && !r) return; // keep last known value on transient failure
    setData({
      balance: Number(u?.rp_balance) || 0,
      rank: r?.rank || null
    });
  };

  createEffect(() => {
    // re-run on login/logout
    isLoggedIn();
    load();
  });

  onMount(() => {
    window.addEventListener('rp-balance-refresh', load);
    onCleanup(() => window.removeEventListener('rp-balance-refresh', load));
  });

  return (
    <Show when={data()}>
      <button
        type="button"
        data-testid="rp-readout"
        class="hover:text-bb-accent cursor-pointer"
        title="Open leaderboard"
        onClick={() => { window.location.hash = '#leaderboard'; }}
      >
        RP:{data().balance.toFixed(2)}{data().rank ? ` #${data().rank}` : ''}
      </button>
    </Show>
  );
}
```

- [ ] **Step 4: Mount in the top bar**

In `TerminalApp.jsx`, add `import TerminalRPBalance from "./terminal/TerminalRPBalance";` and inside the header's Left Block, directly after the `[INTELLACC] USER:` span:

```jsx
          <TerminalRPBalance />
```

- [ ] **Step 5: Dispatch refresh after a trade fill**

In `frontend-solid/src/components/market/MarketDetail.jsx`, in `TradeTicket.submit`, after `setLastFill(result);` add:

```js
            window.dispatchEvent(new CustomEvent('rp-balance-refresh'));
```

- [ ] **Step 6: Run the test until green, then full spec file**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-views.spec.js
```

Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add frontend-solid/src/components/terminal/TerminalRPBalance.jsx frontend-solid/src/components/TerminalApp.jsx frontend-solid/src/components/market/MarketDetail.jsx tests/e2e/terminal-views.spec.js
git commit -m "feat(terminal): live RP balance readout in tmux top bar"
```

---

### Task 4: Server-paginated + searchable market store

**Files:**
- Modify: `frontend-solid/src/store/marketStore.js`
- Modify: `frontend-solid/src/components/MarketPanel.jsx` (search input row)
- Modify: `frontend-solid/src/components/market/MarketList.jsx` (LOAD MORE row + counts)
- Test: `tests/e2e/terminal-market-pagination.spec.js`

**Interfaces:**
- Consumes: `api.events.getPage({ search, limit, offset })` → `{ items, total, hasMore }`.
- Produces: `marketStore.state` gains `total: number`, `hasMore: boolean`, `loadingMore: boolean`, `search: string`. New methods `marketStore.loadMore()` and `marketStore.setSearch(query: string)` (immediate fetch reset; caller debounces). `loadMarkets()` keeps its name (used by TerminalApp hydration effect) and now loads page 1.

- [ ] **Step 1: Write the failing e2e test**

```js
// tests/e2e/terminal-market-pagination.spec.js
// Market pane must be server-paginated (100/page) and server-searchable —
// guards against regressing to render-all-5000-events.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

async function openMarketPane(page, prefix) {
  const u = await createUser(prefix);
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#predictions`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
  await expect(page.locator('[data-testid="market-row"]').first()).toBeVisible({ timeout: 20000 });
}

test('initial market list is capped at one page', async ({ page }) => {
  await openMarketPane(page, 'tmkt1');
  const rows = await page.locator('[data-testid="market-row"]').count();
  expect(rows).toBeLessThanOrEqual(100);
  await expect(page.locator('[data-testid="market-count"]')).toContainText(/\d+\/\d+/);
});

test('LOAD MORE appends the next page', async ({ page }) => {
  await openMarketPane(page, 'tmkt2');
  const before = await page.locator('[data-testid="market-row"]').count();
  await page.locator('[data-testid="market-load-more"]').click();
  await expect
    .poll(async () => page.locator('[data-testid="market-row"]').count(), { timeout: 10000 })
    .toBeGreaterThan(before);
});

test('search queries the server', async ({ page }) => {
  await openMarketPane(page, 'tmkt3');
  await page.locator('[data-testid="market-search"]').fill('zzz-no-such-event-zzz');
  await expect(page.locator('[data-testid="market-empty"]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-testid="market-count"]')).toContainText('0/');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-market-pagination.spec.js
```

Expected: FAIL — `data-testid="market-row"` not found (and today's list renders every event).

- [ ] **Step 3: Rewrite marketStore load path**

Replace `loadMarkets` and the store shape in `frontend-solid/src/store/marketStore.js` (keep `selectMarket`, `getSelectedMarket`, `applyMarketUpdate`, `clear` — update `clear` to reset the new fields):

```js
const PAGE_SIZE = 100;

const [state, setState] = createStore({
    markets: [],
    total: 0,
    hasMore: false,
    search: '',
    loading: false,
    loadingMore: false,
    error: null,
    selectedMarketId: null
});

const fetchPage = async ({ reset }) => {
    if (!getToken()) {
        setState({ markets: [], total: 0, hasMore: false, loading: false, loadingMore: false, error: null });
        return;
    }
    const offset = reset ? 0 : state.markets.length;
    setState(reset ? { loading: true, error: null } : { loadingMore: true, error: null });
    try {
        const res = await api.events.getPage({ search: state.search, limit: PAGE_SIZE, offset });
        const items = Array.isArray(res?.items) ? res.items : [];
        setState({
            markets: reset ? items : [...state.markets, ...items],
            total: Number(res?.total) || items.length,
            hasMore: Boolean(res?.hasMore),
            loading: false,
            loadingMore: false
        });
    } catch (err) {
        console.error("Failed to load markets", err);
        setState({ error: err.message, loading: false, loadingMore: false });
    }
};

const loadMarkets = () => fetchPage({ reset: true });

const loadMore = () => {
    if (state.loadingMore || state.loading || !state.hasMore) return;
    return fetchPage({ reset: false });
};

const setSearch = (query) => {
    setState('search', query);
    return fetchPage({ reset: true });
};

const clear = () => {
    setState({ markets: [], total: 0, hasMore: false, search: '', loading: false, loadingMore: false, error: null, selectedMarketId: null });
};
```

Export `loadMore` and `setSearch` from the `marketStore` object.

- [ ] **Step 4: Search input row in MarketPanel**

In `frontend-solid/src/components/MarketPanel.jsx`, add a search row component at the top of the file:

```jsx
import { Show, createSignal, onCleanup } from "solid-js";

const MarketSearchRow = () => {
    let debounceTimer;
    const [value, setValue] = createSignal(marketStore.state.search);
    onCleanup(() => clearTimeout(debounceTimer));

    const onInput = (e) => {
        const q = e.currentTarget.value;
        setValue(q);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => marketStore.setSearch(q.trim()), 300);
    };

    return (
        <div class="shrink-0 border-b border-bb-border bg-bb-panel px-2 py-1 flex items-center gap-2 font-mono text-xs">
            <span class="text-bb-accent font-bold">/</span>
            <input
                type="text"
                data-testid="market-search"
                class="flex-1 bg-transparent border-none outline-none text-bb-text placeholder-bb-muted"
                placeholder="SEARCH MARKETS..."
                value={value()}
                onInput={onInput}
            />
            <span data-testid="market-count" class="text-bb-muted">
                {marketStore.state.markets.length}/{marketStore.state.total}
            </span>
        </div>
    );
};
```

Render `<MarketSearchRow />` directly under each `<MarketTicker />` slot (both the mobile and md+ variants until Task 5 merges them).

- [ ] **Step 5: LOAD MORE + testids in MarketList**

In `frontend-solid/src/components/market/MarketList.jsx`:
- Add `data-testid="market-row"` to the row `div` inside the `<For>`.
- After the `</For>`, inside the scroll container, add:

```jsx
                <Show when={marketStore.state.markets.length === 0 && !marketStore.state.loading}>
                    <div data-testid="market-empty" class="p-4 text-center text-bb-muted">NO MARKETS MATCH</div>
                </Show>
                <Show when={marketStore.state.hasMore}>
                    <button
                        type="button"
                        data-testid="market-load-more"
                        class="w-full py-2 text-center text-bb-accent border-b border-bb-border/20 hover:bg-bb-accent/10 uppercase font-bold disabled:opacity-50"
                        disabled={marketStore.state.loadingMore}
                        onClick={() => marketStore.loadMore()}
                    >
                        {marketStore.state.loadingMore ? 'LOADING...' : `LOAD MORE (${marketStore.state.markets.length}/${marketStore.state.total})`}
                    </button>
                </Show>
```

- [ ] **Step 6: Run the e2e test until green**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-market-pagination.spec.js
```

Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add frontend-solid/src/store/marketStore.js frontend-solid/src/components/MarketPanel.jsx frontend-solid/src/components/market/MarketList.jsx tests/e2e/terminal-market-pagination.spec.js
git commit -m "perf(terminal): server-paginated + searchable market pane"
```

---

### Task 5: Deduplicate the double-mounted market pane

**Files:**
- Modify: `frontend-solid/src/components/MarketPanel.jsx`
- Test: extend `tests/e2e/terminal-market-pagination.spec.js`

**Interfaces:**
- Consumes: `marketStore.state.selectedMarketId`, `MarketSearchRow` from Task 4.
- Produces: exactly one `MarketList` and one `MarketDetail` in the DOM at any viewport.

Today `MarketPanel` renders a `md:hidden` copy AND a `hidden md:flex` copy of the whole list+detail tree — both stay mounted, doubling the DOM (thousands of rows twice). Replace with single instances toggled by responsive classes.

- [ ] **Step 1: Add the failing e2e assertion** (append to `tests/e2e/terminal-market-pagination.spec.js`)

```js
test('market list is mounted exactly once', async ({ page }) => {
  await openMarketPane(page, 'tmkt4');
  const searchBoxes = await page.locator('[data-testid="market-search"]').count();
  expect(searchBoxes).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-market-pagination.spec.js -g "mounted exactly once"
```

Expected: FAIL — count is 2 (mobile + desktop copies).

- [ ] **Step 3: Rewrite MarketPanel with single instances**

Replace the entire `MarketPanel` return value:

```jsx
export const MarketPanel = () => {
    const hasSelection = () => marketStore.state.selectedMarketId != null;

    // Single list + single detail. On < md, selection swaps list for detail;
    // on md+ both show in a 3/5 - 2/5 vertical split.
    return (
        <div class="h-full flex flex-col md:gap-px">
            <Panel
                title="[2] MARKET DATA // QUOTES"
                class={clsx(
                    "flex-col md:!flex md:h-3/5",
                    hasSelection() ? "hidden" : "flex h-full md:h-3/5"
                )}
            >
                <div class="shrink-0 z-10">
                    <MarketTicker />
                </div>
                <MarketSearchRow />
                <div class="flex-1 min-h-0">
                    <Show when={!marketStore.state.loading} fallback={<div class="p-4 text-bb-muted animate-pulse">Loading Markets...</div>}>
                        <MarketList />
                    </Show>
                </div>
            </Panel>

            <Panel
                title="ORDER BOOK // DEPTH"
                class={clsx(
                    "md:!flex md:h-2/5",
                    hasSelection() ? "flex h-full md:h-2/5" : "hidden"
                )}
            >
                <MarketDetail />
            </Panel>
        </div>
    );
};
```

Add `import { clsx } from "clsx";` and drop the now-unused duplicate blocks. Note: `md:!flex` (important) is required because `hidden` (`display:none`) would otherwise win over `md:flex` when a market is selected on desktop — verify at 1280px wide that BOTH panels show, and at 375px that only one shows.

The mobile `< LIST` back button already exists in `MarketDetail` and clears the selection, restoring the list on mobile.

- [ ] **Step 4: Run the whole market spec + eyeball both viewports**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-market-pagination.spec.js
```

Expected: 4 passed. Additionally take screenshots at both viewports (Playwright `--headed` optional) and confirm: desktop shows list+detail split; mobile shows list, then detail after row click, `< LIST` returns.

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/components/MarketPanel.jsx tests/e2e/terminal-market-pagination.spec.js
git commit -m "perf(terminal): single-mount market list/detail (was double-mounted)"
```

---

### Task 6: Paginated feed with LOAD MORE

**Files:**
- Modify: `frontend-solid/src/store/feedStore.js`
- Modify: `frontend-solid/src/components/FeedPanel.jsx`
- Test: `tests/e2e/terminal-feed-pagination.spec.js`

**Interfaces:**
- Consumes: `api.posts.getPage({ cursor, limit })` and `getPostsPaging(response)` → `{ items, hasMore, nextCursor }` from `services/api`.
- Produces: `feedStore.state` gains `hasMore`, `nextCursor`, `loadingMore`; new method `feedStore.loadMore()`. `loadPosts()` keeps its name and loads page 1. Content source stays `/posts` (public firehose) — switching to the ranked `/feed` + discover fallback is Phase 2 scope (feed-source parity), noted in the spec.

- [ ] **Step 1: Write the failing e2e test**

```js
// tests/e2e/terminal-feed-pagination.spec.js
// Terminal feed must cursor-paginate instead of loading every post.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, apiFetch, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('feed paginates with LOAD MORE', async ({ page }) => {
  const u = await createUser('tfeed1');
  created.push(u);

  // Seed 25 posts (page size is 20) so page 2 exists regardless of DB state.
  for (let i = 0; i < 25; i++) {
    const { response } = await apiFetch('/api/posts', {
      method: 'POST',
      token: u.token,
      body: JSON.stringify({ content: `terminal feed pagination seed ${i}` })
    });
    if (response.status === 403) test.skip(true, 'posting requires verification tier; seed unavailable');
    expect([200, 201]).toContain(response.status);
  }

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  await expect(page.locator('[data-testid="feed-post"]').first()).toBeVisible({ timeout: 20000 });
  const before = await page.locator('[data-testid="feed-post"]').count();
  expect(before).toBeLessThanOrEqual(20);

  await page.locator('[data-testid="feed-load-more"]').click();
  await expect
    .poll(async () => page.locator('[data-testid="feed-post"]').count(), { timeout: 10000 })
    .toBeGreaterThan(before);
});
```

Note: `createUser` may already provision the email tier (check helper); if the 403 skip fires, use `provisionTier` from the helpers to raise the seed user's tier instead of skipping, mirroring how other specs seed posts.

- [ ] **Step 2: Run to verify it fails**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-feed-pagination.spec.js
```

Expected: FAIL — no `feed-load-more` control (store loads everything).

- [ ] **Step 3: Rewrite feedStore load path**

In `frontend-solid/src/store/feedStore.js`, add `getPostsPaging` to the api import, replace state shape + `loadPosts`, add `loadMore`, and update `clear` (keep `addPost`, `updatePost`, `addComment`, `createPost`, `likePost`, `unlikePost` unchanged):

```js
import { api, getPostsPaging } from "../services/api";

const PAGE_LIMIT = 20;

const [state, setState] = createStore({
    posts: [],
    hasMore: false,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null
});

const appendUnique = (current, next) => {
    const seen = new Set(current.map(p => String(p.id)));
    return [...current, ...next.filter(p => !seen.has(String(p.id)))];
};

const fetchPage = async ({ reset }) => {
    if (!getToken()) {
        setState({ posts: [], hasMore: false, nextCursor: null, loading: false, loadingMore: false, error: null });
        return;
    }
    setState(reset ? { loading: true, error: null } : { loadingMore: true, error: null });
    try {
        const cursor = reset ? null : state.nextCursor;
        const response = await api.posts.getPage({ cursor, limit: PAGE_LIMIT });
        const paging = getPostsPaging(response);
        setState({
            posts: reset ? paging.items : appendUnique(state.posts, paging.items),
            hasMore: paging.hasMore,
            nextCursor: paging.nextCursor,
            loading: false,
            loadingMore: false
        });
    } catch (err) {
        console.error("Failed to load posts", err);
        setState({ error: err.message, loading: false, loadingMore: false });
    }
};

const loadPosts = () => fetchPage({ reset: true });

const loadMore = () => {
    if (state.loading || state.loadingMore || !state.hasMore) return;
    return fetchPage({ reset: false });
};

const clear = () => {
    setState({ posts: [], hasMore: false, nextCursor: null, loading: false, loadingMore: false, error: null });
};
```

Export `loadMore` from the `feedStore` object.

- [ ] **Step 4: LOAD MORE + testid in FeedPanel**

In `frontend-solid/src/components/FeedPanel.jsx`:
- In `PostItem`, add `data-testid="feed-post"` to the outer `div`.
- In `FeedPanel`, after the `<For>` list inside the scroll container, add:

```jsx
                    <Show when={feedStore.state.hasMore}>
                        <button
                            type="button"
                            data-testid="feed-load-more"
                            class="w-full py-2 text-center text-bb-accent hover:bg-bb-accent/10 uppercase font-bold font-mono text-xs disabled:opacity-50"
                            disabled={feedStore.state.loadingMore}
                            onClick={() => feedStore.loadMore()}
                        >
                            {feedStore.state.loadingMore ? 'LOADING...' : 'LOAD MORE'}
                        </button>
                    </Show>
```

(Import `Show` is already present in FeedPanel.)

- [ ] **Step 5: Run the e2e test until green**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test tests/e2e/terminal-feed-pagination.spec.js
```

Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add frontend-solid/src/store/feedStore.js frontend-solid/src/components/FeedPanel.jsx tests/e2e/terminal-feed-pagination.spec.js
git commit -m "perf(terminal): cursor-paginated feed with LOAD MORE"
```

---

### Task 7: Phase-1 regression gate

**Files:** none created (verification only)

- [ ] **Step 1: Full phase suite + prior terminal/van specs**

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test \
  tests/e2e/terminal-views.spec.js \
  tests/e2e/terminal-market-pagination.spec.js \
  tests/e2e/terminal-feed-pagination.spec.js \
  tests/e2e/terminal-skin-back.spec.js \
  tests/e2e/predictions-pagination.spec.js \
  tests/e2e/predictions-tabs.spec.js
```

Expected: all pass. `predictions-*` specs guard the van skin against the shared-routes refactor and store changes.

- [ ] **Step 2: Production build check**

```bash
cd frontend-solid && npm run build
```

Expected: success.

- [ ] **Step 3: Manual smoke (screenshots)**

Use Playwright to capture and eyeball:
- `?skin=terminal#home` logged in — RP readout in top bar, feed with LOAD MORE
- `#predictions` — search row, capped list, LOAD MORE
- `#leaderboard` — view over panes, top bar still visible
- 375×812 viewport — panes/tabs still work, view scrolls

- [ ] **Step 4: Report**

Phase 1 done. Do NOT merge or push — surface the branch state and hand off to the superpowers:finishing-a-development-branch skill (user decides merge/PR). Phase 2 (PROFILE, NOTIFICATIONS, SEARCH views; feed comments/images/reposts + feed-source parity; weekly-question slot in the market pane) is planned separately.
