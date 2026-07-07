// E2E: My Positions section on #predictions. The section must show every
// invested market — including junk-hidden ones the browse list filters out —
// plus recently resolved markets, and drop stale resolutions.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';

const psql = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -qtAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

test.describe('my positions section', () => {
  const stamp = Date.now();
  const titles = {
    open: `E2E pos open ${stamp}`,
    hidden: `E2E pos hidden ${stamp}`,
    resolved: `E2E pos resolved ${stamp}`,
    stale: `E2E pos stale ${stamp}`
  };
  let userId;
  const eventIds = {};

  test.beforeAll(() => {
    userId = Number(psql(`SELECT id FROM users WHERE email = 'user1@example.com'`));
    // Trading requires Tier 2 (phone verified); restore tier 1 in afterAll.
    psql(`UPDATE users SET verification_tier = 2 WHERE id = ${userId}`);

    // The open event is multiple_choice so the buy flow can reuse the
    // selectors proven in multi-outcome-trading.spec.js.
    eventIds.open = Number(psql(
      `INSERT INTO events (title, closing_date, event_type, liquidity_b)
       VALUES ('${titles.open}', NOW() + INTERVAL '7 days', 'multiple_choice', 5000) RETURNING id`
    ));
    const o1 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventIds.open}, 'choice_1', 'Alpha', 0) RETURNING id`
    ));
    const o2 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventIds.open}, 'choice_2', 'Beta', 1) RETURNING id`
    ));
    psql(
      `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
       VALUES (${eventIds.open}, ${o1}, 0, 0.5), (${eventIds.open}, ${o2}, 0, 0.5)`
    );
    // staked_ledger 0: the seed never debited the user's balance, so the
    // afterAll refund (which credits staked_ledger back) must not count it.
    psql(
      `INSERT INTO user_outcome_shares (user_id, event_id, outcome_id, shares, staked_ledger)
       VALUES (${userId}, ${eventIds.open}, ${o1}, 4.0, 0)`
    );
    eventIds.hidden = Number(psql(
      `INSERT INTO events (title, closing_date, hidden_at, hidden_reason)
       VALUES ('${titles.hidden}', NOW() + INTERVAL '7 days', NOW(), 'llm: e2e junk') RETURNING id`
    ));
    eventIds.resolved = Number(psql(
      `INSERT INTO events (title, closing_date, outcome, resolved_at)
       VALUES ('${titles.resolved}', NOW() - INTERVAL '3 days', 'resolved_yes', NOW() - INTERVAL '2 days') RETURNING id`
    ));
    eventIds.stale = Number(psql(
      `INSERT INTO events (title, closing_date, outcome, resolved_at)
       VALUES ('${titles.stale}', NOW() - INTERVAL '20 days', 'resolved_no', NOW() - INTERVAL '10 days') RETURNING id`
    ));

    psql(`INSERT INTO user_shares (user_id, event_id, yes_shares) VALUES (${userId}, ${eventIds.hidden}, 5)`);
    psql(
      `INSERT INTO market_updates (user_id, event_id, prev_prob, new_prob, stake_amount, shares_acquired, share_type, hold_until)
       VALUES (${userId}, ${eventIds.resolved}, 0.5, 0.55, 10, 18, 'yes', NOW()),
              (${userId}, ${eventIds.stale}, 0.5, 0.55, 10, 18, 'yes', NOW())`
    );
  });

  test.afterAll(() => {
    const ids = Object.values(eventIds).filter(Boolean).join(',');
    if (ids) {
      // Refund whatever the in-test buy staked before the cascade wipes the
      // share rows (same leak-proofing as multi-outcome-trading.spec.js).
      psql(`UPDATE users u
            SET rp_balance_ledger = rp_balance_ledger + s.staked_ledger,
                rp_staked_ledger = rp_staked_ledger - s.staked_ledger
            FROM user_outcome_shares s
            WHERE s.event_id IN (${ids}) AND s.user_id = u.id AND s.staked_ledger > 0`);
      psql(`DELETE FROM market_outcome_updates WHERE event_id IN (${ids})`);
      psql(`DELETE FROM market_updates WHERE event_id IN (${ids})`);
      psql(`DELETE FROM events WHERE id IN (${ids})`); // cascades share rows
    }
    psql(`UPDATE users SET verification_tier = 1 WHERE id = ${userId}`);
  });

  test('section shows open, hidden, and recently resolved holdings', async ({ page }) => {
    await page.goto(`${BASE}/#login`);
    await page.getByLabel(/email/i).fill('user1@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/#(home|feed)/, { timeout: 15000 });

    await page.goto(`${BASE}/#predictions`);

    // Default-tab regression guard: landing on plain #predictions must show
    // the POSITIONS tab active with its content, with no tab click needed.
    const positionsTab = page.getByRole('tab', { name: 'Positions' });
    await expect(positionsTab).toBeVisible();
    await expect(positionsTab).toHaveAttribute('aria-selected', 'true');

    const section = page.locator('.my-positions-card');
    await expect(section).toBeVisible({ timeout: 20000 });

    // Open position renders the seeded holding and a live trade card.
    const openRow = section.locator('.event-list-item', { hasText: titles.open });
    await expect(openRow).toBeVisible();
    await expect(openRow.locator('.event-category')).toContainText('Alpha ×4.0');

    // Junk-hidden market still shows, marked Unlisted.
    const hiddenRow = section.locator('.event-list-item', { hasText: titles.hidden });
    await expect(hiddenRow).toBeVisible();
    await expect(hiddenRow.locator('.event-unlisted-tag')).toBeVisible();

    // Recently resolved: muted, settled badge.
    const resolvedRow = section.locator('.event-list-item.position-resolved', { hasText: titles.resolved });
    await expect(resolvedRow).toBeVisible();
    await expect(resolvedRow.locator('.event-settled-tag')).toContainText(/YES/i);

    // Resolved 10 days ago: gone.
    await expect(section.locator('.event-list-item', { hasText: titles.stale })).toHaveCount(0);

    // Box fit: with all seeded rows rendered (none expanded), the card must
    // size to its rows, not inherit the 780px frame .events-list-card used
    // before extraction.
    const box = await section.boundingBox();
    expect(box.height).toBeLessThan(700);

    // Settled rows never expand.
    await resolvedRow.locator('.event-list-item-row').click();
    await expect(resolvedRow.locator('.event-row-expanded')).toHaveCount(0);

    // Hidden market stays out of the browsable Markets tab list.
    await page.goto(`${BASE}/#predictions/markets`);
    await expect(page.getByText('Open Questions')).toBeVisible();
    await expect(
      page.locator('.events-list-card .event-list-item', { hasText: titles.hidden })
    ).toHaveCount(0);

    // Back to Positions to expand the open row and trade.
    await page.goto(`${BASE}/#predictions`);
    await expect(section).toBeVisible({ timeout: 20000 });
    await openRow.locator('.event-list-item-row').click();
    const card = openRow.locator('.outcome-market-card');
    await expect(card).toBeVisible({ timeout: 10000 });

    // Buy inside the section — the section must reflect the new shares
    // without a page reload (handleTradeRefresh reloads positions).
    await card.locator('.outcome-row', { hasText: 'Alpha' }).click();
    await card.locator('.stake-input').fill('100');
    await card.getByRole('button', { name: /^buy$/i }).click();
    await expect
      .poll(async () => openRow.locator('.event-category').textContent(), { timeout: 15000 })
      .not.toContain('Alpha ×4.0');

    // Regression: the position row refresh (handleTradeRefresh -> loadUserPositions)
    // must not remount the still-open trading card. If the row is keyed by a
    // freshly-built group object instead of a stable event id, <For> tears the
    // card down and rebuilds it, wiping its local success message/state.
    await expect(card).toBeVisible();
    await expect(card.locator('p.success')).toContainText(/bought .* shares of/i);
  });

  test('logged out shows no section', async ({ page }) => {
    await page.goto(`${BASE}/#predictions`);
    await page.waitForSelector('.events-simple-list li', { timeout: 20000 });

    // Anonymous users default to Markets, and never see a Positions tab.
    await expect(page.getByText('Open Questions')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Markets' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Positions' })).toHaveCount(0);
    await expect(page.locator('.my-positions-card')).toHaveCount(0);
  });
});
