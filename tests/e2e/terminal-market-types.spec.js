// Terminal skin market detail must branch by market type exactly like the
// van skin's MarketDetailView (docs/unified-backlog.md bug: the terminal
// detail rendered its binary YES/NO TradeTicket for EVERY market, including
// numeric distribution markets and multiple_choice markets):
//   - numeric        -> embedded DistributionMarketCard (chart + quote + trade)
//   - multiple_choice -> embedded OutcomeMarketCard (outcome list + buy/sell)
//   - binary         -> the classic terminal TradeTicket (regression)
// plus a mobile (390x844) pass asserting all three trade UIs fit the phone
// viewport with no document horizontal overflow.
//
// Markets are seeded directly in the DB (same pattern as mobile-van.spec.js /
// multi-outcome-trading.spec.js) so the suite never depends on what happens
// to be listed in the shared database. The disposable user and all three
// events are removed in afterAll.
const { test, expect } = require('@playwright/test');
const {
  createUser,
  provisionTopics,
  cleanupUsers,
  dbQuery,
  SOLID_URL
} = require('./helpers/solidMessaging');
const { refundEventStakes } = require('./helpers/stakeRefund');

test.setTimeout(120000);

const stamp = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const binaryTitle = `E2E term-types binary ${stamp}`;
const numericTitle = `E2E term-types numeric ${stamp}`;
const mcTitle = `E2E term-types mc ${stamp}`;

const created = [];
let user;
let binaryEventId;
let numericEventId;
let mcEventId;

test.beforeAll(async () => {
  user = await createUser('ttyp');
  created.push(user);
  // Without topics the blocking onboarding gate replaces every authed page.
  await provisionTopics(user);
  // Trading requires verification tier 2; the user is disposable so no
  // restore is needed (same bump as mobile-van.spec.js).
  dbQuery(`UPDATE users SET verification_tier = 2 WHERE id = ${user.id};`);

  // Open binary market at 50% — the regression test trades against it.
  binaryEventId = Number(dbQuery(`
    INSERT INTO events (title, details, closing_date, event_type, liquidity_b, market_prob)
    VALUES ('${binaryTitle}', 'Seeded by terminal-market-types.spec.js', NOW() + INTERVAL '30 days', 'binary', 5000, 0.5)
    RETURNING id;
  `).split('\n')[0]);
  expect(binaryEventId).toBeGreaterThan(0);

  // Numeric market: 50 linear bins over [0,10], uniform 2% prior, b_numeric
  // copied from the production seed (see numeric-market.spec.js) so quotes
  // and handle math behave exactly like a real market.
  numericEventId = Number(dbQuery(`
    INSERT INTO events (title, details, closing_date, event_type)
    VALUES ('${numericTitle}', 'Seeded by terminal-market-types.spec.js', NOW() + INTERVAL '30 days', 'numeric')
    RETURNING id;
  `).split('\n')[0]);
  expect(numericEventId).toBeGreaterThan(0);
  dbQuery(`
    INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
    SELECT ${numericEventId}, 'bin_' || i,
           (round((i*0.2)::numeric,1))::text || '-' || (round(((i+1)*0.2)::numeric,1))::text,
           i, i*0.2, (i+1)*0.2
    FROM generate_series(0,49) AS i;

    INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
    SELECT ${numericEventId}, id, 0, 0.02 FROM event_outcomes WHERE event_id = ${numericEventId};

    INSERT INTO numeric_market_config
      (event_id, range_min, range_max, zero_point, open_lower_bound, open_upper_bound,
       unit, bin_count, transform, binning_version, b_numeric, numeric_market_version)
    VALUES (${numericEventId}, 0, 10, NULL, false, false, NULL, 50, 'linear', 1, 885.9866097900589, 0);
  `);

  // Multiple-choice market: two outcomes at 50/50 (same seed shape as
  // multi-outcome-trading.spec.js).
  mcEventId = Number(dbQuery(`
    INSERT INTO events (title, details, closing_date, event_type, liquidity_b)
    VALUES ('${mcTitle}', 'Seeded by terminal-market-types.spec.js', NOW() + INTERVAL '30 days', 'multiple_choice', 5000)
    RETURNING id;
  `).split('\n')[0]);
  expect(mcEventId).toBeGreaterThan(0);
  dbQuery(`
    INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
    VALUES (${mcEventId}, 'choice_1', 'Alpha', 0), (${mcEventId}, 'choice_2', 'Beta', 1);

    INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
    SELECT ${mcEventId}, id, 0, 0.5 FROM event_outcomes WHERE event_id = ${mcEventId};
  `);
});

test.afterAll(async () => {
  const ids = [binaryEventId, numericEventId, mcEventId].filter(Boolean).join(',');
  if (ids) {
    // Unwind rp_staked_ledger BEFORE deleting the events (event deletion
    // cascades the share rows but not the users' staked counters).
    refundEventStakes(dbQuery, ids);
    dbQuery(`DELETE FROM market_updates WHERE event_id IN (${ids});
             DELETE FROM events WHERE id IN (${ids});`);
  }
  cleanupUsers(created);
});

// Log in via token (no login-form round trip) and deep-link straight into the
// terminal market detail (#predictions/:id -> marketStore.ensureMarket).
async function openTerminalDetail(page, eventId) {
  await page.addInitScript((t) => localStorage.setItem('token', t), user.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#predictions/${eventId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
  await expect(page.locator('[data-testid="market-detail-title"]')).toBeVisible({ timeout: 20000 });
}

test.describe('desktop', () => {
  test('numeric market shows the distribution UI (no binary ticket) and a trade executes', async ({ page }) => {
    await openTerminalDetail(page, numericEventId);
    await expect(page.locator('[data-testid="market-detail-title"]')).toHaveText(numericTitle);

    const embed = page.locator('[data-testid="terminal-distribution-embed"]');
    await expect(embed).toBeVisible({ timeout: 20000 });

    // Full distribution UI: interactive chart, 3 handle inputs, presets,
    // budget input — and NO binary YES/NO ticket anywhere.
    const svg = embed.locator('svg.distribution-card-chart');
    await expect(svg).toBeVisible({ timeout: 20000 });
    await expect(svg).toHaveClass(/distribution-card-chart-interactive/, { timeout: 20000 });
    await expect(embed.locator('.distribution-card-handle-input')).toHaveCount(3);
    await expect(embed.getByRole('button', { name: /^narrow$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'BUY YES' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'BUY NO' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /place trade/i })).toHaveCount(0);
    // The misleading binary probability readout is replaced by the type tag.
    await expect(page.getByText('Current Probability')).toHaveCount(0);

    // Trade: budget -> debounced quote -> Trade -> success + position block.
    await embed.locator('.distribution-card-budget-input').fill('50');
    await expect(embed.locator('.distribution-card-quote')).toBeVisible({ timeout: 10000 });
    const quoteText = await embed.locator('.distribution-card-quote').innerText();
    expect(Number(quoteText.match(/([\d.]+)\s*RP/)[1])).toBeLessThanOrEqual(50.001);

    await embed.getByRole('button', { name: /^trade$/i }).click();
    await expect(embed.getByText(/Traded for [\d.]+ RP/)).toBeVisible({ timeout: 20000 });
    await expect(embed.locator('.distribution-card-position')).toBeVisible({ timeout: 10000 });
    await expect(embed.getByText('Shares held:')).toBeVisible();
    await expect(embed.getByRole('button', { name: /sell all/i })).toBeVisible();
  });

  test('multiple_choice market shows the outcome list (no binary ticket) and an outcome trade executes', async ({ page }) => {
    await openTerminalDetail(page, mcEventId);
    await expect(page.locator('[data-testid="market-detail-title"]')).toHaveText(mcTitle);

    const embed = page.locator('[data-testid="terminal-outcome-embed"]');
    await expect(embed).toBeVisible({ timeout: 20000 });
    await expect(embed.locator('.outcome-row')).toHaveCount(2, { timeout: 20000 });
    await expect(page.getByRole('button', { name: 'BUY YES' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'BUY NO' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /place trade/i })).toHaveCount(0);

    const alphaRow = embed.locator('.outcome-row', { hasText: 'Alpha' });
    await expect(alphaRow.locator('.outcome-prob')).toHaveText(/50\.0%/);
    await alphaRow.click();
    await expect(alphaRow).toHaveClass(/selected/);

    await embed.locator('.stake-input').fill('10');
    await embed.getByRole('button', { name: /^buy$/i }).click();
    await expect(embed.getByText(/Bought [\d.]+ shares of "Alpha"/)).toBeVisible({ timeout: 20000 });
    // Position block appears and Alpha's price moved above Beta's 50%.
    await expect(embed.getByText('Your Stake:')).toBeVisible({ timeout: 10000 });
    const alphaProb = Number((await alphaRow.locator('.outcome-prob').innerText()).replace('%', ''));
    expect(alphaProb).toBeGreaterThan(50);
  });

  test('binary market still shows the classic TradeTicket and trades (regression)', async ({ page }) => {
    await openTerminalDetail(page, binaryEventId);
    await expect(page.locator('[data-testid="market-detail-title"]')).toHaveText(binaryTitle);

    // Classic ticket, no embedded van cards.
    await expect(page.getByText('Trade Ticket')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: 'BUY YES' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'BUY NO' })).toBeVisible();
    await expect(page.getByText('Current Probability')).toBeVisible();
    await expect(page.locator('[data-testid="terminal-distribution-embed"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="terminal-outcome-embed"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'BUY YES' }).click();
    await page.getByPlaceholder('e.g. 10').fill('10');
    await page.getByRole('button', { name: /place trade/i }).click();
    await expect(page.getByText(/Filled: \+[\d.]+ yes shares/i)).toBeVisible({ timeout: 20000 });
  });
});

// ---------------------------------------------------------------------------
// Mobile pass: all three trade UIs must fit a phone. isMobile is essential,
// not cosmetic: desktop Chromium reserves a ~15px classic scrollbar gutter no
// phone has, which falsifies every "fits in 390px" assertion below. hasTouch
// enables real touch input.
// ---------------------------------------------------------------------------
const VIEWPORT = { width: 390, height: 844 };

test.describe('mobile 390x844', () => {
  test.use({ viewport: VIEWPORT, isMobile: true, hasTouch: true });

  // The page itself must never scroll horizontally on a phone — individual
  // widgets may scroll internally, the document may not.
  async function expectNoPageOverflow(page, label) {
    const metrics = await page.evaluate(() => ({
      htmlScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
      client: document.documentElement.clientWidth
    }));
    expect(metrics.client, `${label}: isMobile viewport must be full-bleed 390`).toBe(VIEWPORT.width);
    expect(metrics.htmlScroll, `${label}: html must not scroll horizontally`).toBeLessThanOrEqual(metrics.client);
    expect(metrics.bodyScroll, `${label}: body must not scroll horizontally`).toBeLessThanOrEqual(metrics.client);
  }

  // "Fully inside the 390px viewport" for a control: on-screen, not clipped.
  async function expectInsideViewportWidth(locator, label) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box, `${label} must be visible (have a bounding box)`).not.toBeNull();
    expect(box.x, `${label} must not start left of the viewport`).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, `${label} must not overflow the 390px viewport`)
      .toBeLessThanOrEqual(VIEWPORT.width + 0.5);
  }

  test('numeric market distribution UI fits 390px', async ({ page }) => {
    await openTerminalDetail(page, numericEventId);
    const embed = page.locator('[data-testid="terminal-distribution-embed"]');
    await expect(embed).toBeVisible({ timeout: 20000 });
    const svg = embed.locator('svg.distribution-card-chart');
    await expect(svg).toBeVisible({ timeout: 20000 });
    await expectNoPageOverflow(page, 'numeric detail');

    for (const [locator, label] of [
      [svg, 'distribution chart'],
      [embed.locator('.distribution-card-handle-input').nth(0), 'P10 input'],
      [embed.locator('.distribution-card-handle-input').nth(1), 'P50 input'],
      [embed.locator('.distribution-card-handle-input').nth(2), 'P90 input'],
      [embed.getByRole('button', { name: /^wide$/i }), 'Wide preset'],
      [embed.locator('.distribution-card-budget-input'), 'trade size input'],
      [embed.getByRole('button', { name: /^trade$/i }), 'Trade button']
    ]) {
      await expectInsideViewportWidth(locator, label);
    }
  });

  test('multiple_choice market outcome UI fits 390px', async ({ page }) => {
    await openTerminalDetail(page, mcEventId);
    const embed = page.locator('[data-testid="terminal-outcome-embed"]');
    await expect(embed).toBeVisible({ timeout: 20000 });
    await expect(embed.locator('.outcome-row')).toHaveCount(2, { timeout: 20000 });
    await expectNoPageOverflow(page, 'multiple_choice detail');

    for (const [locator, label] of [
      [embed.locator('.outcome-row').first(), 'outcome row'],
      [embed.locator('.stake-input'), 'stake input'],
      [embed.getByRole('button', { name: /^buy$/i }), 'Buy button'],
      [embed.getByRole('button', { name: /^sell/i }), 'Sell button']
    ]) {
      await expectInsideViewportWidth(locator, label);
    }
  });

  test('binary market TradeTicket fits 390px', async ({ page }) => {
    await openTerminalDetail(page, binaryEventId);
    await expect(page.getByText('Trade Ticket')).toBeVisible({ timeout: 20000 });
    await expectNoPageOverflow(page, 'binary detail');

    for (const [locator, label] of [
      [page.getByRole('button', { name: 'BUY YES' }), 'BUY YES button'],
      [page.getByRole('button', { name: 'BUY NO' }), 'BUY NO button'],
      [page.getByPlaceholder('e.g. 10'), 'stake input'],
      [page.getByRole('button', { name: /place trade/i }), 'PLACE TRADE button']
    ]) {
      await expectInsideViewportWidth(locator, label);
    }
  });
});
