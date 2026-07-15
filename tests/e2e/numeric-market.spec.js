// E2E: numeric (dense-bin distribution) market trading via DistributionMarketCard.
// Seeds a numeric event with 50 linear bins + numeric_market_config directly in
// the DB (mirroring the real seeded shape of event 1462 — see the plan doc),
// using a disposable tier-2 user (never user1 — this spec's own instructions
// call for an isolated account so it can't collide with other specs' use of
// the shared E2E users).
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';

// -q suppresses the "INSERT 0 1" command tag so Number(psql(...)) doesn't NaN.
const psql = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -qtAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

const psqlExec = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  );

test.describe('numeric market distribution trading', () => {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const title = `E2E numeric market ${stamp}`;
  const mcTitle = `E2E numeric-spec MC market ${stamp}`;
  const userEmail = `numeric_e2e_${stamp}@example.com`;
  const userPassword = 'testpass123';

  let eventId;
  let mcEventId;
  let userId;
  let originalBalanceLedger;

  test.beforeAll(() => {
    userId = Number(psql(
      `CREATE EXTENSION IF NOT EXISTS pgcrypto;
       INSERT INTO users (username, email, password_hash, verification_tier, created_at, updated_at)
       VALUES ('numeric_e2e_${stamp}', '${userEmail}', crypt('${userPassword}', gen_salt('bf')), 2, NOW(), NOW())
       RETURNING id`
    ));
    originalBalanceLedger = Number(psql(`SELECT rp_balance_ledger FROM users WHERE id = ${userId}`));
    // A freshly registered user has zero user_topics rows, which forces the
    // "Pick your topics" onboarding gate in front of every authed page (see
    // topic-onboarding.spec.js) — seed 3 so this disposable account can
    // navigate straight to the market detail page like a real established user.
    psqlExec(
      `INSERT INTO user_topics (user_id, topic_id) SELECT ${userId}, id FROM topics LIMIT 3`
    );

    // Numeric event: 50 linear bins over [0, 10], uniform 2% prior, b_numeric
    // copied from the real seeded market (event 1462, "Economist Democracy
    // Index for Iran") so the LMSR behaves like production.
    eventId = Number(psql(
      `INSERT INTO events (title, details, closing_date, event_type)
       VALUES ('${title}', 'e2e numeric seed', NOW() + INTERVAL '30 days', 'numeric')
       RETURNING id`
    ));
    psqlExec(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
       SELECT ${eventId}, 'bin_' || i,
              (round((i*0.2)::numeric,1))::text || '-' || (round(((i+1)*0.2)::numeric,1))::text,
              i, i*0.2, (i+1)*0.2
       FROM generate_series(0,49) AS i;

       INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
       SELECT ${eventId}, id, 0, 0.02 FROM event_outcomes WHERE event_id = ${eventId};

       INSERT INTO numeric_market_config
         (event_id, range_min, range_max, zero_point, open_lower_bound, open_upper_bound,
          unit, bin_count, transform, binning_version, b_numeric, numeric_market_version)
       VALUES (${eventId}, 0, 10, NULL, false, false, NULL, 50, 'linear', 1, 885.9866097900589, 0);`
    );

    // MC fixture (existing pattern from multi-outcome-trading.spec.js) to
    // confirm the dispatch regression: multiple_choice must still render
    // OutcomeMarketCard, not the new distribution card.
    mcEventId = Number(psql(
      `INSERT INTO events (title, details, closing_date, event_type, liquidity_b)
       VALUES ('${mcTitle}', 'e2e seed', NOW() + INTERVAL '30 days', 'multiple_choice', 5000)
       RETURNING id`
    ));
    const o1 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${mcEventId}, 'choice_1', 'Alpha', 0) RETURNING id`
    ));
    const o2 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${mcEventId}, 'choice_2', 'Beta', 1) RETURNING id`
    ));
    psqlExec(
      `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
       VALUES (${mcEventId}, ${o1}, 0, 0.5), (${mcEventId}, ${o2}, 0, 0.5)`
    );
  });

  test.afterAll(() => {
    // Delete events first: numeric_market_config, event_outcomes,
    // event_outcome_states, distribution_trades(+legs), numeric_position_basis
    // and user_outcome_shares all cascade off events.id. The disposable user
    // is deleted whole afterward (no balance restoration needed).
    if (eventId) psqlExec(`DELETE FROM events WHERE id = ${eventId}`);
    if (mcEventId) psqlExec(`DELETE FROM events WHERE id = ${mcEventId}`);
    if (userId) psqlExec(`DELETE FROM users WHERE id = ${userId}`);
  });

  const login = async (page) => {
    await page.goto(`${BASE}/#login`);
    await page.getByLabel(/email/i).fill(userEmail);
    await page.getByLabel(/password/i).fill(userPassword);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/#(home|feed)/, { timeout: 15000 });
  };

  test('logged out: renders distribution card with svg + handles, trade controls replaced by login prompt', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/${eventId}`);
    const card = page.locator('.distribution-market-card');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator('svg.distribution-card-chart')).toBeVisible();
    await expect(card.locator('.distribution-card-handle-input')).toHaveCount(3);
    await expect(card.locator('.login-prompt')).toBeVisible();
    await expect(card.locator('.distribution-card-budget-input')).toHaveCount(0);

    // Numeric markets must not show the meaningless binary % header.
    await expect(page.locator('.market-detail-prob')).toHaveCount(0);
    await expect(page.locator('.market-detail-header .event-prob-bar')).toHaveCount(0);
  });

  test('logged in: quote appears within budget, trade executes, curve changes, position appears', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#predictions/${eventId}`);
    const card = page.locator('.distribution-market-card');
    await expect(card).toBeVisible({ timeout: 10000 });

    const marketAreaBefore = await card.locator('.distribution-card-market-area').getAttribute('d');

    await card.locator('.distribution-card-budget-input').fill('50');
    await expect(card.locator('.distribution-card-quote')).toBeVisible({ timeout: 5000 });

    const quoteText = await card.locator('.distribution-card-quote').innerText();
    const costMatch = quoteText.match(/([\d.]+)\s*RP/);
    expect(costMatch).not.toBeNull();
    expect(Number(costMatch[1])).toBeLessThanOrEqual(50.001);

    await card.getByRole('button', { name: /^trade$/i }).click();
    await expect(card.locator('.distribution-card-position')).toBeVisible({ timeout: 10000 });

    const marketAreaAfter = await card.locator('.distribution-card-market-area').getAttribute('d');
    expect(marketAreaAfter).not.toEqual(marketAreaBefore);
  });

  test('sell restores balance within 1 RP and clears the position', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#predictions/${eventId}`);
    const card = page.locator('.distribution-market-card');
    await expect(card.locator('.distribution-card-position')).toBeVisible({ timeout: 10000 });

    page.on('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: /sell/i }).click();
    await expect(card.locator('.distribution-card-position')).not.toBeVisible({ timeout: 10000 });

    const balanceAfter = Number(psql(`SELECT rp_balance_ledger FROM users WHERE id = ${userId}`));
    // 1e6 ledger units == 1 RP (LEDGER_SCALE).
    expect(Math.abs(balanceAfter - originalBalanceLedger)).toBeLessThanOrEqual(1000000);
  });

  test('multiple_choice market still renders via OutcomeMarketCard, not the distribution card', async ({ page }) => {
    await page.goto(`${BASE}/#predictions/${mcEventId}`);
    await expect(page.locator('.outcome-market-card')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.distribution-market-card')).toHaveCount(0);
  });
});
