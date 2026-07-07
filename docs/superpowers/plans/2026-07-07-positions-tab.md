# Positions Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the My Positions section into its own POSITIONS tab (default for logged-in users) and make the box content-sized instead of the inherited fixed 780px.

**Architecture:** Extract the positions UI from `EventsList.jsx` (where it currently renders above the market list) into a new `MyPositions.jsx` component rendered as tab content by `PredictionsPage.jsx`. Move code verbatim where possible — especially the stable-primitive-id `<For>` pattern from commit 46e0037, which fixed a remount bug and must not regress. New CSS block for the card so it stops inheriting `.events-list-card { height: 780px }`.

**Tech Stack:** SolidJS, plain CSS (styles.css), Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-07-07-positions-tab-design.md` (read it — it defines the routing table and all behaviors).

## Global Constraints

- Deploy/verify: prod frontend deploy is `docker restart intellacc_frontend_solid` (~2 min build). NEVER `docker compose restart frontend-solid` from repo root (silent no-op) and NEVER verify via localhost:4174 (that is the solid-local DEV container serving the working tree). Verify prod via https://intellacc.de.
- E2E from host: `./tests/e2e/reset-test-users.sh`, then `npx playwright test tests/e2e/<spec>`; base http://localhost:4174 (the dev container — fine for E2E since it serves the working tree; prod verification is separate).
- Shared dev DB: E2E seeds clean up leak-proof (existing afterAll patterns stay).
- The `<For each={positionRowIds()}>` primitive-key pattern and the `positionGroupsById` reactive lookup with `<Show when={group()}>` guard must be preserved exactly (regression: trade success banner survives refresh; E2E asserts it).

---

### Task 1: Extract MyPositions component, add tab, fix box sizing, update E2E

**Files:**
- Create: `frontend-solid/src/components/predictions/MyPositions.jsx`
- Modify: `frontend-solid/src/pages/PredictionsPage.jsx` (tabs + routing)
- Modify: `frontend-solid/src/components/predictions/EventsList.jsx` (remove section; keep Position-tag support)
- Modify: `frontend-solid/src/styles.css` (positions-card sizing + empty/loading states; audit mobile media queries)
- Modify: `tests/e2e/my-positions-section.spec.js`, `tests/e2e/predictions-tabs.spec.js`
- Verify unchanged-green: `tests/e2e/predictions-pagination.spec.js` (logged out → markets default)

**Interfaces:**
- Consumes: `getUserPositions(userId)` payload (position_kind/open|resolved rows), `isAuthenticated`, `getCurrentUserId`, `MarketEventCard`/`OutcomeMarketCard` (props: event, onTrade, onVerificationNotice, hideTitle), CSS contract classes `my-positions-card`, `event-unlisted-tag`, `event-settled-tag`, `event-list-item.position-resolved`.
- Produces: `<MyPositions onVerificationNotice={fn} />`; PredictionsPage hash routing per the spec's table; CSS classes above unchanged in name (E2E contract), plus `my-positions-empty` for the empty state.

- [ ] **Step 1: Create MyPositions.jsx by moving code from EventsList.jsx**

Move (verbatim where possible) from `EventsList.jsx`: the `userPositions`, `positionsLoading`, `positionsError`, `expandedPositionIds` signals; `loadUserPositions`; `positionGroups`, `positionGroupsById`, `positionRowIds` memos; `togglePositionExpanded`; `settledOutcomeText`; the section JSX (the `<div class="events-list-card my-positions-card">` block) — restructured per spec: no collapsible header (plain `<h2>My Positions (n)</h2>` where n = open count), an empty state (`class="my-positions-empty"`, text "No open positions yet." plus a button/link navigating to `#predictions/markets`), a loading line while `positionsLoading()` with no rows yet. Trades inside cards call the component's own reload (`onTrade` → `loadUserPositions`). Load positions on mount for the authed user (same `createEffect` pattern used today, minus EventsList concerns). Keep `formatProbability`/`formatDate` helpers (copy the small helpers or import if shared — they are module-local in EventsList; copy them).

- [ ] **Step 2: EventsList.jsx cleanup**

Remove the section JSX and everything only it used (`positionsError`, `positionsSectionOpen`, `expandedPositionIds`, `togglePositionExpanded`, `positionGroups`, `positionGroupsById`, `positionRowIds`, `settledOutcomeText`). KEEP `userPositions`, `positionsLoading`, `loadUserPositions`, the positions-loading `createEffect`, `positionEventIds`, the "Position" row tag, and the `refreshSelected` positions reload — the Markets tab still shows Position tags.

- [ ] **Step 3: PredictionsPage.jsx tabs + routing**

Implement the spec's hash table:

```jsx
const activeTab = createMemo(() => {
  const param = String(props.marketId || '').trim().toLowerCase();
  if (param === 'submit') return 'submit';
  if (param === 'leaderboard') return 'leaderboard';
  if (param === 'admin' && isAdmin()) return 'admin';
  if (param === 'markets') return 'markets';
  if (param === 'positions') return 'positions';
  if (/^\d+$/.test(param)) return 'markets';
  return isAuthenticated() ? 'positions' : 'markets';
});

const goToTab = (tab) => {
  window.location.hash = tab === 'positions' ? 'predictions' : `predictions/${tab}`;
};
```

Note `goToTab('markets')` → `predictions/markets` now. Tab row: POSITIONS button first, `<Show when={isAuthenticated()}>`-gated; then MARKETS, SUBMIT, LEADERBOARD, ADMIN. Tab body: `<Show when={activeTab() === 'positions'}><MyPositions onVerificationNotice={handleVerificationNotice} /></Show>`. The verification-notice banner plumbing on the page already exists — reuse it. `targetedMarketId` logic unchanged.

- [ ] **Step 4: CSS**

In `styles.css`: give the positions card its own sizing so `class="events-list-card my-positions-card"` can DROP `events-list-card` in the JSX — the new tab card is `<div class="my-positions-card">` only. New/updated rules near the existing `.my-positions-*` block: card `height: auto`, normal block flow, same padding/box-shadow/radius language as `events-list-card` minus the 780px height and flex clamp; the inner `ul.events-simple-list` inside `.my-positions-card` gets `flex: initial; overflow-y: visible; height: auto` (scope with a descendant selector — do not change `.events-simple-list` globally); `.my-positions-empty` and the loading line styled per surrounding Bauhaus idiom (1px borders, no rounded fluff beyond var(--border-radius)); keep/carry dark-mode overrides; delete the now-dead `.my-positions-header` collapse styles if nothing uses them. Audit the media queries that touch `.events-list-card`/`.events-simple-list` (styles.css ~lines 2299-2330, 4625-4640, 4975-5000, 5071, 5196) for rules the positions tab needs at mobile widths (the page is used on phones — tab must not overflow).

- [ ] **Step 5: E2E updates**

`tests/e2e/my-positions-section.spec.js`:
- Logged-in test: after login, `goto ${BASE}/#predictions` → assert the POSITIONS tab button exists and is active (`aria-selected="true"`) and `.my-positions-card` is visible WITHOUT clicking any tab (default-tab regression guard). Existing assertions adapt: unlisted row, settled row non-expandable, stale absent, buy flow + success-banner survival stay within the positions tab; the "hidden market absent from browse list" assertion now first navigates to the markets tab (`#predictions/markets`) and checks the market list there (the old `.events-list-card:not(.my-positions-card)` scoping can simplify to the markets tab's list).
- Add a box-fit assertion: with the seeded rows rendered, `(await page.locator('.my-positions-card').boundingBox()).height` is, say, `< 700` (regression guard against the inherited 780px fixed height).
- Logged-out test: `#predictions` shows MARKETS active, no POSITIONS tab button, no `.my-positions-card`.

`tests/e2e/predictions-tabs.spec.js`: read it first; update tab-set/default expectations to match (logged-out default markets; if it logs in anywhere, positions default).

- [ ] **Step 6: Run E2E**

```bash
./tests/e2e/reset-test-users.sh
npx playwright test tests/e2e/my-positions-section.spec.js tests/e2e/predictions-tabs.spec.js
npx playwright test tests/e2e/predictions-pagination.spec.js  # must stay green unchanged
```

- [ ] **Step 7: Commit**

```bash
git add frontend-solid/src/components/predictions/MyPositions.jsx frontend-solid/src/pages/PredictionsPage.jsx frontend-solid/src/components/predictions/EventsList.jsx frontend-solid/src/styles.css tests/e2e/my-positions-section.spec.js tests/e2e/predictions-tabs.spec.js
git commit -m "feat(predictions): POSITIONS tab — default for logged-in users, content-sized card

Section extracted from EventsList into MyPositions.jsx; #predictions lands
on positions when authed, markets otherwise; predictions/markets addresses
the market list; card no longer inherits the 780px list frame.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Deploy to prod and verify live

- [ ] **Step 1:** `docker restart intellacc_frontend_solid`; wait until `docker exec intellacc_frontend_solid sh -c 'grep -l "my-positions-empty" dist/assets/*.js'` matches (new build marker).
- [ ] **Step 2:** `curl -s https://intellacc.de/ | grep -o 'assets/index-[^\"]*\.js'` → fetch that bundle, grep for `my-positions-empty` (confirms Caddy path serves the new build).
- [ ] **Step 3:** Report done; user reloads intellacc.de and lands on their positions.
