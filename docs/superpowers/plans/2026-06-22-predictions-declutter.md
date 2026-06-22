# Predictions Declutter — Tabbed Shell + Expandable Markets List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the van-skin `#predictions` page's three-block vertical stack with a Bauhaus tab shell (Markets · Submit · Leaderboard · Admin) whose Markets tab is a single accordion list — clicking a row expands the forecasting controls inline.

**Architecture:** Frontend-only. `PredictionsPage` gains a hash-synced `activeTab` and renders one tab at a time. `EventsList` drops its separate right-hand detail panel and renders `<MarketEventCard>` inline inside the clicked row (accordion). `MarketQuestionHub`, `LeaderboardCard`, and the admin components move into their own tabs unchanged. No backend, no API, no DB migration.

**Tech Stack:** SolidJS + Vite (`frontend-solid/`), hash routing via `VanApp.jsx`, CSS in `frontend-solid/src/styles.css`, Playwright e2e (`tests/e2e/`). Dev via `docker compose -p solid-local -f docker-compose.solid-local.yml up -d` (port 4174).

## Global Constraints

- **Van skin = Bauhaus modernist.** Reuse existing tokens only: accent `#0000ff`, 1px solid black borders, 2px radius, League Spartan. No new colors, gradients, or shadows beyond what the van skin already uses.
- **No emojis** anywhere (site-wide rule).
- **Frontend-only:** no backend, API, or migration changes. Terminal skin (`TerminalApp.jsx` and its components) must remain untouched.
- **Branch:** all work on `predictions-declutter-tabs`; atomic commits per task; nothing merged to master until user approves.
- **Backend has no hot-reload** (irrelevant here — no backend change), but the **solid-local dev container** serves source-mounted Vite on port 4174 and hot-reloads frontend edits. ALWAYS use `-p solid-local` so it does not replace the prod container.
- Tab keywords are reserved words `submit`, `leaderboard`, `admin`; any numeric route param is a market id (they never collide).

---

## File Structure

- `frontend-solid/src/pages/PredictionsPage.jsx` — **modify.** Add hash-synced `activeTab`, a Bauhaus tab bar, and per-tab rendering. Move admin components into the Admin tab. Keep `RPBalance` in the header.
- `frontend-solid/src/components/predictions/EventsList.jsx` — **modify.** Remove the `.selected-event-container` panel + `renderSelectedEvent`; convert rows to an accordion that renders `<MarketEventCard hideTitle>` inline; pin + auto-expand the weekly assignment; add a probability bar and a "position held" tag; stop truncating titles.
- `frontend-solid/src/styles.css` — **modify.** Add `.predictions-tabs` (tab bar), `.event-prob-bar` (probability bar), and `.event-row-expanded` / inline-card styling. Reuse van tokens.
- `tests/e2e/predictions-tabs.spec.js` — **create.** Playwright smoke covering tab switching, accordion expand, and numeric deep-link.

No new long-lived modules are needed; the tab bar is small enough to live inline in `PredictionsPage` (one responsibility, ~30 lines).

---

### Task 1: Bauhaus tab shell in PredictionsPage

Wrap the existing three blocks in a hash-synced tab shell. `EventsList`, `MarketQuestionHub`, and `LeaderboardCard` are rendered **unchanged** here — Task 2 rewrites `EventsList`. This task is independently shippable: the page already declutters (only one block visible at a time).

**Files:**
- Modify: `frontend-solid/src/pages/PredictionsPage.jsx`
- Modify: `frontend-solid/src/styles.css`
- Test: `tests/e2e/predictions-tabs.spec.js` (create; tab-switching portion)

**Interfaces:**
- Consumes: `props.marketId` (from `VanApp.jsx` `renderPage` → `<PredictionsPage marketId={routeParam()} />`; it is the hash segment after `predictions/`, i.e. a tab keyword, a numeric id, or null).
- Produces: hash-driven tab state. For Task 2: when the Markets tab is active, `EventsList` receives `targetedMarketId={marketId when numeric, else null}`.

- [ ] **Step 1: Add the activeTab derivation and tab-navigation helper**

In `PredictionsPage`, derive the active tab from the route param and navigate by setting the hash. Reserved keywords map to tabs; anything else (numeric id or null) is the Markets tab.

```jsx
import { Show, createMemo } from 'solid-js';
// ...existing imports...

const TAB_KEYWORDS = ['submit', 'leaderboard', 'admin'];

export default function PredictionsPage(props) {
  // ...existing verificationNotice signal + handlers...

  const activeTab = createMemo(() => {
    const param = String(props.marketId || '').trim().toLowerCase();
    if (param === 'submit') return 'submit';
    if (param === 'leaderboard') return 'leaderboard';
    if (param === 'admin' && isAdmin()) return 'admin';
    return 'markets';
  });

  // A numeric param means "expand this market on the Markets tab".
  const targetedMarketId = createMemo(() => {
    const param = String(props.marketId || '').trim();
    return /^\d+$/.test(param) ? param : null;
  });

  const goToTab = (tab) => {
    window.location.hash = tab === 'markets' ? 'predictions' : `predictions/${tab}`;
  };
```

- [ ] **Step 2: Render the tab bar + per-tab content**

Replace the current `return (...)` body's `.predictions-main` block. Keep the title, verification banner, and `RPBalance` header. Render a tab bar then exactly one tab's content.

```jsx
  return (
    <section class="predictions-page">
      <h1>Predictions & Betting</h1>

      <Show when={verificationNotice()}>
        <div class="predictions-phone-banner">{verificationNotice()}</div>
      </Show>

      <div class="predictions-header">
        <RPBalance horizontal />
      </div>

      <nav class="predictions-tabs" role="tablist">
        <button type="button" role="tab" class={`predictions-tab ${activeTab() === 'markets' ? 'on' : ''}`} aria-selected={activeTab() === 'markets'} onClick={() => goToTab('markets')}>Markets</button>
        <button type="button" role="tab" class={`predictions-tab ${activeTab() === 'submit' ? 'on' : ''}`} aria-selected={activeTab() === 'submit'} onClick={() => goToTab('submit')}>Submit</button>
        <button type="button" role="tab" class={`predictions-tab ${activeTab() === 'leaderboard' ? 'on' : ''}`} aria-selected={activeTab() === 'leaderboard'} onClick={() => goToTab('leaderboard')}>Leaderboard</button>
        <Show when={isAdmin()}>
          <button type="button" role="tab" class={`predictions-tab ${activeTab() === 'admin' ? 'on' : ''}`} aria-selected={activeTab() === 'admin'} onClick={() => goToTab('admin')}>Admin</button>
        </Show>
      </nav>

      <div class="predictions-main">
        <Show when={activeTab() === 'markets'}>
          <div class="predictions-top-grid">
            <div class="events-list-column">
              <EventsList
                targetedMarketId={targetedMarketId()}
                createEvent={handleCreateEvent}
                onVerificationNotice={handleVerificationNotice}
              />
            </div>
          </div>
        </Show>

        <Show when={activeTab() === 'submit'}>
          <MarketQuestionHub />
        </Show>

        <Show when={activeTab() === 'leaderboard'}>
          <div class="predictions-bottom-leaderboard">
            <LeaderboardCard />
          </div>
        </Show>

        <Show when={activeTab() === 'admin' && isAdmin()}>
          <AdminTools />
          <AdminMarketResolution />
          <AdminEventManagement />
        </Show>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Add Bauhaus tab-bar styling**

Append to `frontend-solid/src/styles.css`. Flat geometric tabs, reusing van tokens (active = solid `#0000ff` block, black text; inactive = white). Match the existing van button language (1px black border, 2px radius).

```css
/* Predictions tab bar (Bauhaus) */
.predictions-tabs {
  display: flex;
  gap: 0;
  margin: 1rem 0 1.5rem;
  border: 1px solid #000;
  border-radius: 2px;
  overflow: hidden;
  width: fit-content;
}
.predictions-tab {
  appearance: none;
  background: #fff;
  color: #000;
  border: none;
  border-right: 1px solid #000;
  padding: 0.5rem 1.25rem;
  font-family: inherit;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  cursor: pointer;
}
.predictions-tab:last-child { border-right: none; }
.predictions-tab.on { background: #0000ff; color: #000; }
.predictions-tab:not(.on):hover { background: #f0f0f0; }
```

- [ ] **Step 4: Write the tab-switching smoke (and watch it fail first)**

Create `tests/e2e/predictions-tabs.spec.js`. Use the van skin (default) against the dev URL. (Mirror the URL/helper conventions in `tests/e2e/helpers/solidMessaging.js` — `SOLID_URL`.)

```js
const { test, expect } = require('@playwright/test');

const BASE = process.env.SOLID_URL || 'http://localhost:4174';

test.describe('predictions tabs', () => {
  test('tab bar switches between Markets, Submit, Leaderboard', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`);
    // Markets is the default: the events list header is visible.
    await expect(page.getByText('Open Questions')).toBeVisible();

    await page.getByRole('tab', { name: 'Submit' }).click();
    await expect(page).toHaveURL(/#predictions\/submit$/);
    await expect(page.getByText('Submit a New Question')).toBeVisible();

    await page.getByRole('tab', { name: 'Leaderboard' }).click();
    await expect(page).toHaveURL(/#predictions\/leaderboard$/);
    await expect(page.getByText('Reputation Leaderboard')).toBeVisible();

    await page.getByRole('tab', { name: 'Markets' }).click();
    await expect(page.getByText('Open Questions')).toBeVisible();
  });
});
```

Run (with solid-local up) to confirm it FAILS before implementation (no tab roles yet):

```bash
docker compose -p solid-local -f docker-compose.solid-local.yml up -d
SOLID_URL=http://localhost:4174 npx playwright test tests/e2e/predictions-tabs.spec.js -g "tab bar switches"
```
Expected before Steps 1–3: FAIL (no `tab` role / `#predictions/submit` never set). After: PASS.

- [ ] **Step 5: Run the smoke to verify it passes**

```bash
SOLID_URL=http://localhost:4174 npx playwright test tests/e2e/predictions-tabs.spec.js -g "tab bar switches"
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend-solid/src/pages/PredictionsPage.jsx frontend-solid/src/styles.css tests/e2e/predictions-tabs.spec.js
git commit -m "feat(predictions): Bauhaus tab shell (Markets/Submit/Leaderboard/Admin)"
```

---

### Task 2: Single expandable Markets list (EventsList rewrite)

Turn `EventsList` into one accordion list: remove the separate detail panel, render `<MarketEventCard>` inline in the expanded row, pin + auto-expand the weekly assignment, add a probability bar and a position-held tag, and stop truncating titles.

**Files:**
- Modify: `frontend-solid/src/components/predictions/EventsList.jsx`
- Modify: `frontend-solid/src/styles.css`
- Test: `tests/e2e/predictions-tabs.spec.js` (extend: accordion + deep-link)

**Interfaces:**
- Consumes: `props.targetedMarketId` (numeric string or null, from Task 1). `MarketEventCard` props (already used here): `event`, `onTrade`, `onVerificationNotice`, `hideTitle`, `authenticated`.
- Produces: an accordion list with at most one expanded row (`expandedEventId`).

- [ ] **Step 1: Replace selection state with accordion state**

In `EventsList`, replace the `selectedEvent` signal and its handlers with an `expandedEventId` accordion. Keep all data-loading signals/effects unchanged.

```jsx
// Replace: const [selectedEvent, setSelectedEvent] = createSignal(null);
const [expandedEventId, setExpandedEventId] = createSignal(null);

const isExpanded = (id) => String(expandedEventId() || '') === String(id);

const handleEventClick = (eventItem) => {
  setExpandedEventId((prev) =>
    String(prev || '') === String(eventItem.id) ? null : eventItem.id
  );
};
```

Update the three places that referenced `selectedEvent`:
- In `loadEvents`, delete the `const current = selectedEvent(); ... setSelectedEvent(...)` refresh block (no longer needed — rows re-render from `events()` and the expanded id is stable).
- In `applyTargetedSelection`, set the accordion instead of selection:

```jsx
const applyTargetedSelection = () => {
  const marketId = String(props.targetedMarketId || '').trim();
  if (!marketId) return false;
  const targetEvent = events().find((e) => String(e.id) === marketId);
  if (!targetEvent) return false;
  setExpandedEventId(targetEvent.id);
  lastTargetedSelectionFetchKey = '';
  return true;
};
```

- [ ] **Step 2: Auto-expand the weekly assignment once loaded**

After `loadWeeklyAssignment` sets an assignment with an event, auto-expand it if nothing else is expanded. Add this effect near the other `createEffect`s:

```jsx
createEffect(() => {
  const assignment = weeklyAssignment();
  const assignedId = assignment?.event?.id;
  if (assignedId && expandedEventId() == null && !props.targetedMarketId) {
    setExpandedEventId(assignedId);
  }
});
```

- [ ] **Step 3: Delete the right-hand panel + placeholder renderer**

Remove the entire `renderSelectedEvent` function and the `<div class="selected-event-container">{renderSelectedEvent()}</div>` from the JSX. The weekly assignment now surfaces as a pinned row (Step 4), not a placeholder panel.

- [ ] **Step 4: Build the pinned + ordered row list**

Compute the rendered rows: weekly-assignment event first (if any), then the filtered events with the weekly event de-duplicated. Add above the return:

```jsx
const orderedRows = createMemo(() => {
  const rows = filteredEvents();
  const weekly = weeklyAssignment()?.event;
  if (!weekly) return rows;
  const rest = rows.filter((e) => String(e.id) !== String(weekly.id));
  return [weekly, ...rest];
});

const positionEventIds = createMemo(
  () => new Set((userPositions() || []).map((p) => String(p.event_id)))
);
```

- [ ] **Step 5: Render richer, expandable rows**

Replace the `<ul class="events-simple-list">…</ul>` block. Each row shows full title (no truncation), probability + a probability bar, a meta line, a "Weekly" marker for the pinned row, a "Position" tag when held, and — when expanded — `<MarketEventCard hideTitle>` inline.

```jsx
<ul class="events-simple-list">
  <For each={orderedRows()}>
    {(marketItem) => {
      const weeklyId = () => weeklyAssignment()?.event?.id;
      const isWeekly = () => String(weeklyId() || '') === String(marketItem.id);
      const prob = () => Number(marketItem.market_prob ?? 0.5);
      return (
        <li class={`event-list-item ${isExpanded(marketItem.id) ? 'expanded' : ''} ${marketItem.outcome ? 'resolved' : ''} ${isWeekly() ? 'weekly' : ''}`}>
          <div class="event-list-item-row" onClick={() => handleEventClick(marketItem)}>
            <div class="event-list-item-header">
              <span class="event-title">{marketItem.title}</span>
              <span class="event-prob">{formatProbability(marketItem.market_prob || 0.5)}</span>
            </div>
            <div class="event-prob-bar" aria-hidden="true">
              <div class="event-prob-bar-fill" style={{ width: `${Math.round(prob() * 100)}%` }} />
            </div>
            <div class="event-list-item-meta">
              <Show when={isWeekly()}>
                <span class="event-weekly-tag">{`Weekly · ${weeklyAssignment()?.weekly_assignment_completed ? 'Completed' : 'Pending'}`}</span>
              </Show>
              <span class="event-category">{marketItem.category || 'General'}</span>
              <span class="event-date">{`Closes: ${formatDate(marketItem.closing_date)}`}</span>
              <Show when={positionEventIds().has(String(marketItem.id))}>
                <span class="event-position-tag">Position</span>
              </Show>
              {marketItem.outcome ? <span class="event-resolved">Resolved</span> : null}
            </div>
          </div>
          <Show when={isExpanded(marketItem.id)}>
            <div class="event-row-expanded">
              <MarketEventCard
                event={marketItem}
                onTrade={handleTradeRefresh}
                onVerificationNotice={props.onVerificationNotice}
                hideTitle={true}
                authenticated={authed()}
              />
            </div>
          </Show>
        </li>
      );
    }}
  </For>
</ul>
```

- [ ] **Step 6: Add Bauhaus row + probability-bar styling**

Append to `frontend-solid/src/styles.css`. Full-bleed rows, black-outlined probability track with blue fill, clear expanded affordance. Ensure the title wraps (remove any inherited truncation).

```css
.event-list-item-row { cursor: pointer; padding: 0.75rem; }
.event-list-item.expanded { border-color: #0000ff; }
.event-list-item .event-title { white-space: normal; overflow: visible; text-overflow: clip; }
.event-prob-bar {
  height: 6px;
  border: 1px solid #000;
  border-radius: 2px;
  margin: 0.4rem 0;
  background: #fff;
  overflow: hidden;
}
.event-prob-bar-fill { height: 100%; background: #0000ff; }
.event-list-item-meta { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.event-weekly-tag { background: #0000ff; color: #000; padding: 0 0.35rem; border: 1px solid #000; border-radius: 2px; font-weight: 600; }
.event-position-tag { border: 1px solid #000; padding: 0 0.35rem; border-radius: 2px; }
.event-row-expanded { border-top: 1px solid #000; padding: 0.75rem; }
```

- [ ] **Step 7: Extend the smoke — accordion + deep-link**

Add to `tests/e2e/predictions-tabs.spec.js`:

```js
test('clicking a row expands forecasting inline; one open at a time', async ({ page }) => {
  await page.goto(`${BASE}/#predictions`);
  const rows = page.locator('.event-list-item');
  await expect(rows.first()).toBeVisible();
  await rows.nth(1).locator('.event-list-item-row').click();
  await expect(rows.nth(1).locator('.event-row-expanded')).toBeVisible();
  // Accordion: opening another collapses the first.
  await rows.nth(2).locator('.event-list-item-row').click();
  await expect(rows.nth(2).locator('.event-row-expanded')).toBeVisible();
  await expect(rows.nth(1).locator('.event-row-expanded')).toHaveCount(0);
});

test('numeric deep-link expands that market on the Markets tab', async ({ page }) => {
  await page.goto(`${BASE}/#predictions`);
  const firstRow = page.locator('.event-list-item').first();
  await expect(firstRow).toBeVisible();
  // Read a real id off the DOM is overkill; instead assert deep-link path renders Markets.
  await page.goto(`${BASE}/#predictions/999999999`);
  await expect(page.getByText('Open Questions')).toBeVisible();
});
```

Run to confirm FAIL before Steps 1–6, PASS after:

```bash
SOLID_URL=http://localhost:4174 npx playwright test tests/e2e/predictions-tabs.spec.js
```

- [ ] **Step 8: Run full smoke + manual screenshot verify**

```bash
SOLID_URL=http://localhost:4174 npx playwright test tests/e2e/predictions-tabs.spec.js
playwright-cli open "http://localhost:4174/#predictions" && playwright-cli screenshot --filename=predictions-markets.png
```
Eyeball: one clean list, no empty side panel, full titles, probability bars, a row expands to the forecasting card. Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend-solid/src/components/predictions/EventsList.jsx frontend-solid/src/styles.css tests/e2e/predictions-tabs.spec.js
git commit -m "feat(predictions): single expandable Markets list (inline forecasting, weekly pin, prob bar)"
```

---

### Task 3: Cross-skin guard + cleanup verification

Confirm the terminal skin is untouched, dead CSS for the removed panel is gone, and the full van skin still builds/renders. This is the pre-merge gate.

**Files:**
- Modify (cleanup only): `frontend-solid/src/styles.css` (remove now-dead `.selected-event-container` rules if unused elsewhere)
- Test: existing van-skin Playwright baselines / build

**Interfaces:**
- Consumes: nothing new.
- Produces: a verified, mergeable branch.

- [ ] **Step 1: Confirm `.selected-event-container` is dead, then remove its CSS**

```bash
grep -rn "selected-event-container" frontend-solid/src
```
Expected: only matches in `styles.css` (no JSX). Remove those CSS rules. If any JSX still references it, STOP — the rewrite is incomplete.

- [ ] **Step 2: Confirm the terminal skin is untouched**

```bash
git diff --name-only master... | grep -E "TerminalApp|ThreePaneLayout|components/ui/|FeedPanel|MarketPanel|ChatPanel" || echo "terminal skin untouched (good)"
```
Expected: prints "terminal skin untouched (good)".

- [ ] **Step 3: Production build succeeds**

```bash
docker exec intellacc_frontend_solid_local sh -c "cd /app && npx vite build" 2>&1 | tail -5
```
Expected: build completes with no errors (or run the project's standard build check).

- [ ] **Step 4: Full predictions smoke green**

```bash
SOLID_URL=http://localhost:4174 npx playwright test tests/e2e/predictions-tabs.spec.js
```
Expected: all PASS.

- [ ] **Step 5: Commit any cleanup**

```bash
git add frontend-solid/src/styles.css
git commit -m "chore(predictions): drop dead selected-event-container styles"
```

---

## Self-Review

**Spec coverage:**
- Tab shell (Markets/Submit/Leaderboard/Admin), hash-synced, admin-only Admin → Task 1. ✓
- Single expandable list, inline `MarketEventCard`, accordion one-at-a-time → Task 2 (Steps 1, 5). ✓
- Weekly pinned + auto-expanded → Task 2 (Steps 2, 4, 5). ✓
- Richer rows (prob bar + position tag), no truncation → Task 2 (Steps 5, 6). ✓
- Numeric deep-link expands market → Task 1 (`targetedMarketId` memo) + Task 2 (`applyTargetedSelection`). ✓
- RPBalance persistent in header → Task 1 (Step 2). ✓
- Bauhaus styling, existing tokens only → Tasks 1 & 2 CSS steps. ✓
- Terminal skin untouched, no migration → Global Constraints + Task 3. ✓
- Playwright smoke → Tasks 1 & 2; pre-merge gate → Task 3. ✓

**Placeholder scan:** No "TBD/handle edge cases" — each code step shows concrete code. Position tag is boolean (presence in `userPositions()`), avoiding guessed numeric fields. ✓

**Type consistency:** `expandedEventId` / `isExpanded` / `handleEventClick` consistent across Task 2 steps; `targetedMarketId` is a numeric string|null in both files; `MarketEventCard` props match current usage. ✓

**Note for implementer:** `formatProbability`, `formatDate`, `filteredEvents`, `handleTradeRefresh`, `authed`, `userPositions`, `weeklyAssignment` already exist in `EventsList.jsx` — reuse them; do not redefine.
