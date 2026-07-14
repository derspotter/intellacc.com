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
});
