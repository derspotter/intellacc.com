# Market Detail View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selecting a prediction on the predictions page opens a full detail view (`#predictions/<id>`) — header, description, probability-history curve, trading card, recent activity — replacing the inline accordion in the markets list.

**Architecture:** Frontend-only (SolidJS). A new `MarketDetailView` component renders in `.predictions-main` when the hash segment after `predictions/` is numeric. It reuses the existing trading cards and the existing backend trades proxy (`GET /api/events/:id/trades`). `EventsList` rows navigate instead of expanding; the accordion machinery is removed.

**Tech Stack:** SolidJS, hash routing (VanApp), hand-rolled inline SVG (no chart dependency), Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-07-14-market-detail-view-design.md`

## Global Constraints

- No backend or prediction-engine changes. The trades endpoint (`backend/src/routes/api.js:422` → engine `/events/:id/trades`) and `getEventById` (`backend/src/routes/api.js:228`) already exist.
- All CSS goes in `frontend-solid/src/styles.css` using `.market-detail*` class names and existing tokens (`--border-color`, `--border-radius`, `--box-shadow`). No Tailwind in van-skin components.
- E2E runs from the host against the **solid-local dev container** (source-mounted Vite on `http://localhost:4174`). Start it with `docker compose -p solid-local -f docker-compose.solid-local.yml up -d` — the `-p solid-local` flag is MANDATORY (without it the command replaces the production container).
- `localhost:4174` is dev; production is verified only via `https://intellacc.de`. Production frontend deploy = `docker restart intellacc_frontend_solid` (~2 min build outage).
- E2E test users: `user1@example.com` / `password123`. Trading requires `verification_tier >= 2` — seed it in `beforeAll`, restore `1` in `afterAll` (pattern in `tests/e2e/my-positions-section.spec.js`).
- `psql` from specs via: `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -qtAc "..."`.
- `MyPositions.jsx` keeps its own accordion — do NOT remove shared CSS classes it uses (`.event-row-expanded`, `.event-list-item.expanded`, etc.) and do not touch that component.
- The trades response shape is `{ event_id, trades: [...], count }`; each trade: `{ id, user, direction, amount, shares_acquired, price_before, price_after, timestamp }`, multi-outcome trades additionally have `market_type: "multi_outcome"` and their outcome label as `direction`.
- Trading cards accept: `event`, `onTrade` (called with eventId after a trade), `onVerificationNotice`, `hideTitle`.

---

### Task 1: MarketDetailView component + route

**Files:**
- Modify: `frontend-solid/src/services/api.js` (events section, after `getById` ~line 678)
- Create: `frontend-solid/src/components/predictions/MarketDetailView.jsx`
- Modify: `frontend-solid/src/pages/PredictionsPage.jsx`
- Modify: `frontend-solid/src/styles.css` (append to the Events List section)
- Modify: `tests/e2e/predictions-tabs.spec.js` (numeric deep-link test)
- Test: `tests/e2e/market-detail.spec.js` (new)

**Interfaces:**
- Consumes: `api.events.getById(eventId)` → event row `{ id, title, details, closing_date, outcome, category, event_type, market_prob, ... }` (no `topics` array — fall back to `category`); backend trades proxy.
- Produces: `api.events.getTrades(eventId, limit)` → `{ trades: [...] }`; `MarketDetailView` component with props `{ marketId, onVerificationNotice }`; `activeTab() === 'detail'` state in PredictionsPage. Task 2 inserts the chart into this component; Task 3 relies on `.market-detail`, `.market-detail-title` selectors.

- [ ] **Step 1: Start the dev stack and reset test users**

```bash
docker compose -p solid-local -f docker-compose.solid-local.yml up -d
./tests/e2e/reset-test-users.sh
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4174   # expect 200
```

- [ ] **Step 2: Write the failing E2E test**

Create `tests/e2e/market-detail.spec.js`:

```js
// E2E: market detail view. `#predictions/<id>` renders the selected market in
// full (header, description, trading card, activity) instead of the list.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';

const psql = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -qtAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

test.describe('market detail view', () => {
  const stamp = Date.now();
  const titles = {
    binary: `E2E detail binary ${stamp}`,
    quiet: `E2E detail quiet ${stamp}`,
    multi: `E2E detail multi ${stamp}`
  };
  let userId;
  const eventIds = {};

  test.beforeAll(() => {
    userId = Number(psql(`SELECT id FROM users WHERE email = 'user1@example.com'`));
    // Trading (Task 4) requires Tier 2; restored in afterAll.
    psql(`UPDATE users SET verification_tier = 2 WHERE id = ${userId}`);

    eventIds.binary = Number(psql(
      `INSERT INTO events (title, details, closing_date, event_type, liquidity_b, market_prob)
       VALUES ('${titles.binary}', 'Detailed description for the E2E detail spec.',
               NOW() + INTERVAL '7 days', 'binary', 5000, 0.62) RETURNING id`
    ));
    // Two seeded trades: powers the activity feed and (Task 2) the curve.
    psql(
      `INSERT INTO market_updates
         (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until, created_at)
       VALUES
         (${userId}, ${eventIds.binary}, 0.50, 0.55, 50, 90, 'yes', NOW(), NOW() - INTERVAL '3 hours'),
         (${userId}, ${eventIds.binary}, 0.55, 0.62, 60, 100, 'yes', NOW(), NOW() - INTERVAL '1 hour')`
    );

    // Binary market with no trades: no activity feed, no curve.
    eventIds.quiet = Number(psql(
      `INSERT INTO events (title, closing_date, event_type, liquidity_b)
       VALUES ('${titles.quiet}', NOW() + INTERVAL '7 days', 'binary', 5000) RETURNING id`
    ));

    // Multi-outcome market: detail view renders, curve stays hidden (Task 2).
    eventIds.multi = Number(psql(
      `INSERT INTO events (title, closing_date, event_type, liquidity_b)
       VALUES ('${titles.multi}', NOW() + INTERVAL '7 days', 'multiple_choice', 5000) RETURNING id`
    ));
    const o1 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventIds.multi}, 'choice_1', 'Alpha', 0) RETURNING id`
    ));
    const o2 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventIds.multi}, 'choice_2', 'Beta', 1) RETURNING id`
    ));
    psql(
      `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
       VALUES (${eventIds.multi}, ${o1}, 0, 0.5), (${eventIds.multi}, ${o2}, 0, 0.5)`
    );
  });

  test.afterAll(() => {
    const ids = Object.values(eventIds).filter(Boolean).join(',');
    if (ids) {
      psql(`DELETE FROM market_updates WHERE event_id IN (${ids})`);
      psql(`DELETE FROM events WHERE id IN (${ids})`); // cascades outcome rows
    }
    psql(`UPDATE users SET verification_tier = 1 WHERE id = ${userId}`);
  });

  const login = async (page) => {
    await page.goto(`${BASE}/#login`);
    await page.getByLabel(/email/i).fill('user1@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/#(home|feed)/, { timeout: 15000 });
  };

  test('deep link renders the market in full (logged out)', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/${eventIds.binary}`, { waitUntil: 'domcontentloaded' });

    const detail = page.locator('.market-detail');
    await expect(detail).toBeVisible({ timeout: 20000 });

    // The old accordion list must NOT render alongside the detail view.
    await expect(page.locator('.events-list-card')).toHaveCount(0);

    // Markets tab reads as active while inside a market.
    await expect(page.getByRole('tab', { name: 'Markets' })).toHaveAttribute('aria-selected', 'true');

    await expect(detail.locator('.market-detail-title')).toHaveText(titles.binary);
    await expect(detail.locator('.market-detail-prob')).toContainText('62.0%');
    await expect(detail.locator('.market-detail-description'))
      .toContainText('Detailed description for the E2E detail spec.');
    await expect(detail.locator('.market-detail-back')).toBeVisible();

    // Seeded trades appear as recent activity.
    const rows = detail.locator('.market-detail-trade-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('user1');
    await expect(rows.first()).toContainText('55.0% → 62.0%');

    // Trading card renders (anonymous variant is fine — just present).
    await expect(detail.locator('.event-card')).toBeVisible();
  });

  test('market with no trades shows no activity section', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/${eventIds.quiet}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.market-detail-title')).toHaveText(titles.quiet, { timeout: 20000 });
    await expect(page.locator('.market-detail-activity')).toHaveCount(0);
  });

  test('unknown id shows market not found with a way back', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/999999999`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.market-detail')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('Market not found')).toBeVisible();
    await expect(page.locator('.market-detail-back')).toBeVisible();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx playwright test tests/e2e/market-detail.spec.js
```

Expected: all 3 tests FAIL — `.market-detail` never appears (numeric hash currently shows the markets list with an expanded accordion row).

- [ ] **Step 4: Add `api.events.getTrades`**

In `frontend-solid/src/services/api.js`, directly after the `getById` entry in the `events` object (~line 678):

```js
    getById: (eventId) =>
      request(`/events/${eventId}`),

    // Recent trades for a market (newest first): { event_id, trades, count }.
    getTrades: (eventId, limit = 200) =>
      request(`/events/${eventId}/trades?limit=${limit}`),
```

- [ ] **Step 5: Create `MarketDetailView.jsx`**

Create `frontend-solid/src/components/predictions/MarketDetailView.jsx`:

```jsx
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { api } from '../../services/api';
import MarketEventCard from './MarketEventCard';
import OutcomeMarketCard from './OutcomeMarketCard';
import { formatProbability } from './marketCardShared';

const TRADES_LIMIT = 200;
const ACTIVITY_COUNT = 15;

const isMultiOutcome = (eventItem) =>
  ['multiple_choice', 'numeric'].includes(eventItem?.event_type);

const formatDate = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'No date';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatTradeTime = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

export default function MarketDetailView(props) {
  const [event, setEvent] = createSignal(null);
  const [trades, setTrades] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [notFound, setNotFound] = createSignal(false);

  const loadAll = async (id) => {
    let row = null;
    try {
      row = await api.events.getById(id);
    } catch {
      row = null;
    }
    if (!row?.id) {
      setNotFound(true);
      setEvent(null);
      setTrades([]);
      return;
    }
    setNotFound(false);
    setEvent(row);
    try {
      const response = await api.events.getTrades(id, TRADES_LIMIT);
      setTrades(Array.isArray(response?.trades) ? response.trades : []);
    } catch {
      setTrades([]);
    }
  };

  createEffect(() => {
    const id = String(props.marketId || '').trim();
    if (!/^\d+$/.test(id)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadAll(id).finally(() => setLoading(false));
  });

  const handleTradeRefresh = () => {
    void loadAll(String(props.marketId || '').trim());
  };

  const prob = () => Number(event()?.market_prob ?? 0.5);

  const activity = createMemo(() => trades().slice(0, ACTIVITY_COUNT));

  const categoryLabel = () =>
    (event()?.topics || []).length > 0
      ? event().topics.join(' · ')
      : (event()?.category || 'General');

  return (
    <section class="market-detail">
      <a class="market-detail-back" href="#predictions/markets">← Back to markets</a>

      <Show when={loading()}>
        <div class="events-loading">
          <div class="loading-spinner" />
          <p>Loading market...</p>
        </div>
      </Show>

      <Show when={!loading() && notFound()}>
        <div class="no-events">
          <h3>Market not found</h3>
          <p>This market does not exist or is no longer available.</p>
        </div>
      </Show>

      <Show when={!loading() && !notFound() && event()}>
        <header class="market-detail-header">
          <div class="market-detail-title-row">
            <h2 class="market-detail-title">{event().title}</h2>
            <span class="market-detail-prob">{formatProbability(event().market_prob)}</span>
          </div>
          <div class="event-prob-bar" aria-hidden="true">
            <div class="event-prob-bar-fill" style={{ width: `${Math.round(prob() * 100)}%` }} />
          </div>
          <div class="market-detail-meta">
            <span class="event-category">{categoryLabel()}</span>
            <span class="event-date">{`Closes: ${formatDate(event().closing_date)}`}</span>
            <Show when={event().outcome}>
              <span class="event-resolved">Resolved</span>
            </Show>
          </div>
        </header>

        <Show when={String(event().details || '').trim()}>
          <div class="market-detail-description">{event().details}</div>
        </Show>

        <div class="market-detail-trade">
          <Show
            when={isMultiOutcome(event())}
            fallback={
              <MarketEventCard
                event={event()}
                onTrade={handleTradeRefresh}
                onVerificationNotice={props.onVerificationNotice}
                hideTitle={true}
              />
            }
          >
            <OutcomeMarketCard
              event={event()}
              onTrade={handleTradeRefresh}
              onVerificationNotice={props.onVerificationNotice}
              hideTitle={true}
            />
          </Show>
        </div>

        <Show when={activity().length > 0}>
          <div class="market-detail-activity">
            <h3>Recent activity</h3>
            <ul>
              <For each={activity()}>
                {(trade) => (
                  <li class="market-detail-trade-row">
                    <span class="trade-user">{trade.user}</span>
                    <span class="trade-direction">{trade.direction}</span>
                    <span class="trade-amount">{`${Number(trade.amount).toFixed(2)} RP`}</span>
                    <span class="trade-move">
                      {`${formatProbability(trade.price_before)} → ${formatProbability(trade.price_after)}`}
                    </span>
                    <span class="trade-time">{formatTradeTime(trade.timestamp)}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </Show>
    </section>
  );
}
```

- [ ] **Step 6: Wire the route in `PredictionsPage.jsx`**

Three edits in `frontend-solid/src/pages/PredictionsPage.jsx`:

(a) Add the import next to the other predictions components:

```js
import MarketDetailView from '../components/predictions/MarketDetailView';
```

(b) Replace the `activeTab` memo and its comment (lines 40–53):

```js
  // The hash segment after `predictions/` is either a reserved tab keyword,
  // a numeric market id (full detail view of that market), or empty. Empty
  // defaults to Positions for logged-in users (anonymous users have no
  // positions, so they default to Markets).
  const activeTab = createMemo(() => {
    const param = String(props.marketId || '').trim().toLowerCase();
    if (param === 'submit') return 'submit';
    if (param === 'leaderboard') return 'leaderboard';
    if (param === 'admin' && isAdmin()) return 'admin';
    if (param === 'markets') return 'markets';
    if (param === 'positions') return 'positions';
    if (/^\d+$/.test(param)) return 'detail';
    return isAuthenticated() ? 'positions' : 'markets';
  });
```

(c) The Markets tab button stays highlighted in detail view — replace the Markets `<button>`:

```jsx
        <button type="button" role="tab" class={`predictions-tab ${activeTab() === 'markets' || activeTab() === 'detail' ? 'on' : ''}`} aria-selected={activeTab() === 'markets' || activeTab() === 'detail'} onClick={() => goToTab('markets')}>Markets</button>
```

(d) Add the detail branch inside `.predictions-main`, after the markets `<Show>` block:

```jsx
        <Show when={activeTab() === 'detail'}>
          <MarketDetailView
            marketId={targetedMarketId()}
            onVerificationNotice={handleVerificationNotice}
          />
        </Show>
```

Leave `targetedMarketId` and the `EventsList` props untouched for now — Task 3 cleans them up.

- [ ] **Step 7: Add CSS**

Append to `frontend-solid/src/styles.css` at the end of the Events List section (after the `.event-row-expanded` rules):

```css
/* Market detail view (#predictions/<id>) */
.market-detail {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1rem;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  box-shadow: var(--box-shadow);
}

.market-detail-back {
  align-self: flex-start;
  font-weight: 600;
  text-decoration: none;
}

.market-detail-back:hover {
  text-decoration: underline;
}

.market-detail-title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}

.market-detail-title {
  margin: 0;
}

.market-detail-prob {
  font-size: 1.75rem;
  font-weight: 700;
  white-space: nowrap;
}

.market-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 0.5rem;
  font-size: 0.85rem;
  opacity: 0.85;
}

.market-detail-description {
  white-space: pre-wrap;
  line-height: 1.5;
}

.market-detail-activity h3 {
  margin: 0 0 0.5rem;
}

.market-detail-activity ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.market-detail-trade-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--border-color);
  font-size: 0.85rem;
}

.market-detail-trade-row:last-child {
  border-bottom: none;
}

.market-detail-trade-row .trade-direction {
  font-weight: 700;
}

.market-detail-trade-row .trade-time {
  margin-left: auto;
  opacity: 0.7;
}
```

- [ ] **Step 8: Update the stale deep-link test in `predictions-tabs.spec.js`**

Replace the `numeric deep-link stays on the Markets tab` test:

```js
  test('numeric deep-link opens the market detail view', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/999999999`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.market-detail')).toBeVisible();
    await expect(page.getByText('Market not found')).toBeVisible();
    // Markets tab stays highlighted while inside a market.
    await expect(page.getByRole('tab', { name: 'Markets' })).toHaveAttribute('aria-selected', 'true');
  });
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
npx playwright test tests/e2e/market-detail.spec.js tests/e2e/predictions-tabs.spec.js
```

Expected: `market-detail.spec.js` 3/3 PASS. In `predictions-tabs.spec.js` the deep-link test passes; the `clicking a market expands forecasting inline in place` test still passes (accordion untouched until Task 3).

- [ ] **Step 10: Commit**

```bash
git add frontend-solid/src/services/api.js \
        frontend-solid/src/components/predictions/MarketDetailView.jsx \
        frontend-solid/src/pages/PredictionsPage.jsx \
        frontend-solid/src/styles.css \
        tests/e2e/market-detail.spec.js \
        tests/e2e/predictions-tabs.spec.js
git commit -m "feat(predictions): market detail view at #predictions/<id>"
```

---

### Task 2: Probability history curve

**Files:**
- Modify: `frontend-solid/src/components/predictions/MarketDetailView.jsx`
- Modify: `frontend-solid/src/styles.css`
- Test: `tests/e2e/market-detail.spec.js` (add tests)

**Interfaces:**
- Consumes: `trades()` / `event()` signals from Task 1; trade fields `timestamp`, `price_before`, `price_after`, `market_type`.
- Produces: `.market-detail-chart` block containing an `<svg>` with a `.chart-line` polyline. Hidden when: multi-outcome event, or fewer than 2 binary trades.

- [ ] **Step 1: Add failing E2E tests**

Add to `tests/e2e/market-detail.spec.js` inside the describe block:

```js
  test('binary market with trades shows the probability curve', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/${eventIds.binary}`, { waitUntil: 'domcontentloaded' });
    const chart = page.locator('.market-detail-chart');
    await expect(chart).toBeVisible({ timeout: 20000 });
    await expect(chart.locator('svg polyline.chart-line')).toHaveCount(1);
    // Step line: seed anchor (0.50) + 2 trades + now → at least 4 vertices.
    const points = await chart.locator('polyline.chart-line').getAttribute('points');
    expect(points.split(' ').length).toBeGreaterThanOrEqual(4);
  });

  test('markets without enough history show no curve', async ({ page }) => {
    // Fewer than 2 trades → no chart.
    await page.goto(`${BASE}/#predictions/${eventIds.quiet}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.market-detail-title')).toHaveText(titles.quiet, { timeout: 20000 });
    await expect(page.locator('.market-detail-chart')).toHaveCount(0);

    // Multi-outcome → no chart either (per-outcome history not exposed).
    await page.goto(`${BASE}/#predictions/${eventIds.multi}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.market-detail-title')).toHaveText(titles.multi, { timeout: 20000 });
    await expect(page.locator('.market-detail-chart')).toHaveCount(0);
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx playwright test tests/e2e/market-detail.spec.js
```

Expected: the two new tests FAIL (`.market-detail-chart` never renders); Task 1's tests still pass.

- [ ] **Step 3: Implement the chart**

In `MarketDetailView.jsx`, add below the `activity` memo:

```js
  // Probability history as an SVG step line. Binary markets only —
  // market_updates has no per-outcome history for multi-outcome events.
  const CHART_W = 640;
  const CHART_H = 180;
  const CHART_PAD = 10;

  const chartPoints = createMemo(() => {
    const row = event();
    if (!row || isMultiOutcome(row)) return null;

    const history = trades()
      .filter((trade) => trade.market_type !== 'multi_outcome')
      .map((trade) => ({
        t: Date.parse(trade.timestamp),
        p: Number(trade.price_after),
        before: Number(trade.price_before)
      }))
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p))
      .sort((a, b) => a.t - b.t);
    if (history.length < 2) return null;

    // Anchor at the earliest trade's starting price, extend to now at the
    // current market probability.
    const series = [
      { t: history[0].t, p: history[0].before },
      ...history.map(({ t, p }) => ({ t, p })),
      { t: Date.now(), p: Number(row.market_prob ?? 0.5) }
    ];

    const t0 = series[0].t;
    const span = Math.max(series[series.length - 1].t - t0, 1);
    const toX = (t) => CHART_PAD + ((t - t0) / span) * (CHART_W - 2 * CHART_PAD);
    const toY = (p) => CHART_PAD + (1 - Math.min(Math.max(p, 0), 1)) * (CHART_H - 2 * CHART_PAD);

    // Step line: hold each probability until the next trade.
    const coords = [];
    let prevY = null;
    for (const point of series) {
      const x = toX(point.t);
      const y = toY(point.p);
      if (prevY !== null) coords.push(`${x.toFixed(1)},${prevY}`);
      prevY = y.toFixed(1);
      coords.push(`${x.toFixed(1)},${prevY}`);
    }
    return coords.join(' ');
  });

  const gridY = (p) => CHART_PAD + (1 - p) * (CHART_H - 2 * CHART_PAD);
```

Then insert the chart markup between the description block and `.market-detail-trade`:

```jsx
        <Show when={chartPoints()}>
          <div class="market-detail-chart">
            <h3>Probability history</h3>
            <div class="market-detail-chart-body">
              <div class="chart-y-labels" aria-hidden="true">
                <span>100%</span>
                <span>50%</span>
                <span>0%</span>
              </div>
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                preserveAspectRatio="none"
                role="img"
                aria-label="Market probability over time"
              >
                <line class="chart-grid" x1={CHART_PAD} y1={gridY(0.75)} x2={CHART_W - CHART_PAD} y2={gridY(0.75)} />
                <line class="chart-grid" x1={CHART_PAD} y1={gridY(0.5)} x2={CHART_W - CHART_PAD} y2={gridY(0.5)} />
                <line class="chart-grid" x1={CHART_PAD} y1={gridY(0.25)} x2={CHART_W - CHART_PAD} y2={gridY(0.25)} />
                <polyline class="chart-line" points={chartPoints()} />
              </svg>
            </div>
          </div>
        </Show>
```

- [ ] **Step 4: Add chart CSS**

Append after the `.market-detail-trade-row` rules in `styles.css`:

```css
.market-detail-chart h3 {
  margin: 0 0 0.5rem;
}

.market-detail-chart-body {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
}

.market-detail-chart svg {
  flex: 1;
  min-width: 0;
  height: 180px;
  display: block;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
}

.market-detail-chart .chart-grid {
  stroke: var(--border-color);
  stroke-width: 1;
}

.market-detail-chart .chart-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}

.market-detail-chart .chart-y-labels {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  font-size: 0.7rem;
  opacity: 0.7;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx playwright test tests/e2e/market-detail.spec.js
```

Expected: 5/5 PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend-solid/src/components/predictions/MarketDetailView.jsx frontend-solid/src/styles.css tests/e2e/market-detail.spec.js
git commit -m "feat(predictions): probability history curve on market detail"
```

---

### Task 3: List rows navigate; remove the accordion

**Files:**
- Modify: `frontend-solid/src/components/predictions/EventsList.jsx`
- Modify: `frontend-solid/src/pages/PredictionsPage.jsx`
- Modify: `tests/e2e/keyboard-navigation.spec.js`
- Modify: `tests/e2e/predictions-tabs.spec.js`
- Test: `tests/e2e/market-detail.spec.js` (add tests)

**Interfaces:**
- Consumes: `.market-detail`, `.market-detail-title`, `.market-detail-back` from Task 1.
- Produces: `EventsList` rows navigate to `#predictions/<id>` on click/Enter. `EventsList` no longer accepts `targetedMarketId`, `createEvent`, or `onVerificationNotice` props.

- [ ] **Step 1: Add failing E2E tests**

Add to `tests/e2e/market-detail.spec.js`:

```js
  test('clicking a market in the list opens its detail view, back returns', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/markets`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.events-filters input[type="text"]', { timeout: 20000 });
    await page.locator('.events-filters input[type="text"]').fill(titles.binary);

    const row = page.locator('.event-list-item', { hasText: titles.binary });
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.locator('.event-list-item-row').click();

    await expect(page).toHaveURL(new RegExp(`#predictions/${eventIds.binary}$`));
    await expect(page.locator('.market-detail-title')).toHaveText(titles.binary);
    // Nothing expands inline anymore.
    await expect(page.locator('.events-list-card')).toHaveCount(0);

    await page.locator('.market-detail-back').click();
    await expect(page).toHaveURL(/#predictions\/markets$/);
    await expect(page.getByText('Open Questions')).toBeVisible();
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx playwright test tests/e2e/market-detail.spec.js
```

Expected: the new test FAILS — clicking the row expands the accordion in place, the URL never changes.

- [ ] **Step 3: Rewrite row activation in `EventsList.jsx`**

Remove these pieces (all obsolete once rows navigate):

- imports of `MarketEventCard` and `OutcomeMarketCard`, and the `isMultiOutcome` helper
- the `expandedIds` signal and `isExpanded` (lines 60–62)
- `lastTargetedSelectionFetchKey`, `applyTargetedSelection`, and the whole targeted-selection `createEffect` (lines 76, 136–186)
- the accordion-toggle `handleEventClick` and its "Independent toggles" comment block (lines 297–310)
- the weekly auto-expand `createEffect` (lines 312–320)

Add the navigation handler where `handleEventClick` was:

```js
  // Selecting a market opens its full detail view (#predictions/<id>).
  const openMarket = (eventItem) => {
    window.location.hash = `predictions/${eventItem.id}`;
  };
```

Replace the `<li>` block in the `<For>` (drop `expanded` class, `aria-expanded`, and the whole `event-row-expanded` `<Show>`):

```jsx
                      <li
                        class={`event-list-item ${marketItem.outcome ? 'resolved' : ''} ${isWeekly() ? 'weekly' : ''}`}
                      >
                        <div
                          class="event-list-item-row"
                          data-kb-row
                          role="button"
                          tabindex="0"
                          onClick={() => openMarket(marketItem)}
                          onKeyDown={activateOnKey(() => openMarket(marketItem))}
                        >
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
                            <span class="event-category">
                              {(marketItem.topics || []).length > 0
                                ? marketItem.topics.join(' · ')
                                : (marketItem.category || 'General')}
                            </span>
                            <span class="event-date">{`Closes: ${formatDate(marketItem.closing_date)}`}</span>
                            <Show when={positionEventIds().has(String(marketItem.id))}>
                              <span class="event-position-tag">Position</span>
                            </Show>
                            {marketItem.outcome ? <span class="event-resolved">Resolved</span> : null}
                          </div>
                        </div>
                      </li>
```

Keep everything else (weekly pinning via `orderedRows`, `positionEventIds`, filters, pagination, `refreshSelected` — it is still used by the Refresh button). `handleTradeRefresh` becomes unused once the cards are gone — delete it too. Do NOT touch `MyPositions.jsx` or any `.event-row-expanded` CSS (MyPositions still uses both.)

- [ ] **Step 4: Clean up dead props in `PredictionsPage.jsx`**

The markets branch becomes:

```jsx
        <Show when={activeTab() === 'markets'}>
          <div class="predictions-top-grid">
            <div class="events-list-column">
              <EventsList />
            </div>
          </div>
        </Show>
```

Also delete the now-dead `handleCreateEvent` function and the `createEvent` import from `../services/api` (`EventsList` never used the `createEvent` prop — pre-existing dead code). Keep `handleVerificationNotice` (used by `MyPositions` and `MarketDetailView`) and `targetedMarketId` (used by the detail branch).

- [ ] **Step 5: Update the two accordion-dependent specs**

In `tests/e2e/keyboard-navigation.spec.js`, replace the `market row expands with Enter and collapses with Escape` test:

```js
  test('market row opens the detail view with Enter', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#predictions/markets`);
    await page.waitForSelector('.events-simple-list li');
    const firstRow = page.locator('.event-list-item-row').first();
    await firstRow.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#predictions\/\d+$/);
    await expect(page.locator('.market-detail')).toBeVisible();
  });
```

In the `arrow keys jump between sidebar and market list` test, clicking a row now navigates away — focus it instead. Replace:

```js
    await page.locator('.event-list-item-row').first().click();
```

with:

```js
    await page.locator('.event-list-item-row').first().focus();
```

(and update the comment above it: focusing avoids both the fixed-coordinate problem and the click-to-navigate behavior).

In `tests/e2e/predictions-tabs.spec.js`, replace the `clicking a market expands forecasting inline in place (no movement)` test:

```js
  test('clicking a market opens its detail view', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.event-list-item .event-title');
    const title = (await page.locator('.event-list-item .event-title').nth(1).textContent()).trim();
    await page.$$eval('.event-list-item .event-list-item-row', (els) => els[1].click());
    await expect(page).toHaveURL(/#predictions\/\d+$/);
    await expect(page.locator('.market-detail-title')).toHaveText(title);
  });
```

- [ ] **Step 6: Run all affected specs**

```bash
npx playwright test tests/e2e/market-detail.spec.js tests/e2e/predictions-tabs.spec.js tests/e2e/keyboard-navigation.spec.js tests/e2e/predictions-pagination.spec.js tests/e2e/my-positions-section.spec.js
```

Expected: all PASS. `my-positions-section.spec.js` matters here: it proves the MyPositions accordion still works after the EventsList surgery.

- [ ] **Step 7: Commit**

```bash
git add frontend-solid/src/components/predictions/EventsList.jsx \
        frontend-solid/src/pages/PredictionsPage.jsx \
        tests/e2e/keyboard-navigation.spec.js \
        tests/e2e/predictions-tabs.spec.js \
        tests/e2e/market-detail.spec.js
git commit -m "feat(predictions): market rows navigate to detail view, drop inline accordion"
```

---

### Task 4: Trade-from-detail E2E, build gate, deploy

**Files:**
- Test: `tests/e2e/market-detail.spec.js` (add test)

**Interfaces:**
- Consumes: everything above; `MarketEventCard` trade form selectors: `.direction-btn.yes-btn`, `.stake-input`, submit button "Place Stake"; `login` helper and Tier-2 seeding from Task 1.

- [ ] **Step 1: Add the trade E2E test**

Add to `tests/e2e/market-detail.spec.js`:

```js
  test('placing a trade updates the header and activity feed', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#predictions/${eventIds.binary}`);

    const probText = page.locator('.market-detail-prob');
    await expect(probText).toBeVisible({ timeout: 20000 });
    const before = await probText.textContent();

    const card = page.locator('.market-detail .event-card');
    await card.locator('.direction-btn.yes-btn').click();
    await card.locator('.stake-input').fill('100');
    await card.getByRole('button', { name: /place stake/i }).click();

    // onTrade refetches event + trades: header prob and activity both move.
    await expect
      .poll(async () => probText.textContent(), { timeout: 15000 })
      .not.toBe(before);
    await expect(page.locator('.market-detail-trade-row').first()).toContainText('user1');
  });
```

- [ ] **Step 2: Run the full spec**

```bash
./tests/e2e/reset-test-users.sh
npx playwright test tests/e2e/market-detail.spec.js
```

Expected: 6/6 PASS. (The trade test needs the Tier-2 seeding from `beforeAll` and user1's RP balance from the reset script.)

- [ ] **Step 3: Production build gate**

The dev server hides build-only failures; run the real build in a disposable container (repo root mount is required for the `@shared` Vite alias):

```bash
docker run --rm -v /var/opt/docker/intellacc.com:/repo -w /repo/frontend-solid node:24 \
  sh -c "npm ci && npm run build"
```

Expected: `vite build` completes with no errors.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/market-detail.spec.js
git commit -m "test(e2e): trade from market detail view updates header and activity"
```

- [ ] **Step 5: Deploy and verify**

Deploy is durably approved after verified features. NOTE the ~2 min build outage; don't stack restarts:

```bash
docker restart intellacc_frontend_solid
# wait for the build inside the container:
docker logs -f intellacc_frontend_solid   # until vite preview is serving
```

Verify against production (NOT localhost:4174 — that's the dev container):
open `https://intellacc.de/#predictions/markets`, click a market, confirm the detail view renders with the curve, then check a deep link reload works.

- [ ] **Step 6: Push and watch CI**

```bash
git push
gh run watch
```

Expected: CI green (backend jest, MLS guard, frontend build, e2e-smoke are unaffected, but confirm — local subset runs have hidden red CI before).
