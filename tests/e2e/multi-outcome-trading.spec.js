// E2E: multi-outcome trading loop.
// Seeds a multiple_choice event directly in the DB, then drives the UI:
// select event -> pick outcome -> buy -> price shifts -> sell -> position gone.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');
const { refundEventStakes } = require('./helpers/stakeRefund');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';

// -q suppresses the command tag ("INSERT 0 1") that psql prints after
// RETURNING output even with -tA — without it, Number(result) is NaN.
const psql = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -qtAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

test.describe('multi-outcome trading', () => {
  let eventId;
  const title = `E2E MC market ${Date.now()}`;

  test.beforeAll(() => {
    // Trading routes require Tier 2 (phone verified); reset-test-users.sh
    // leaves user1 at tier 1, so raise it for this spec and restore after.
    psql(`UPDATE users SET verification_tier = 2 WHERE email = 'user1@example.com'`);
    eventId = Number(psql(
      `INSERT INTO events (title, details, closing_date, event_type, liquidity_b)
       VALUES ('${title}', 'e2e seed', NOW() + INTERVAL '7 days', 'multiple_choice', 5000)
       RETURNING id`
    ));
    const o1 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventId}, 'choice_1', 'Alpha', 0) RETURNING id`
    ));
    const o2 = Number(psql(
      `INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order)
       VALUES (${eventId}, 'choice_2', 'Beta', 1) RETURNING id`
    ));
    psql(
      `INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
       VALUES (${eventId}, ${o1}, 0, 0.5), (${eventId}, ${o2}, 0, 0.5)`
    );
  });

  test.afterAll(() => {
    if (eventId) {
      // Refund any position left by a failed run before deleting the event —
      // the cascade wipes user_outcome_shares but NOT users.rp_staked_ledger,
      // so a bare DELETE leaks staked RP on the test account.
      refundEventStakes(psql, String(eventId));
      psql(`DELETE FROM events WHERE id = ${eventId}`);
    }
    psql(`UPDATE users SET verification_tier = 1 WHERE email = 'user1@example.com'`);
  });

  test('buy then sell an outcome via the UI', async ({ page }) => {
    await page.goto(`${BASE}/#login`);
    await page.getByLabel(/email/i).fill('user1@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/#(home|feed)/, { timeout: 15000 });

    await page.goto(`${BASE}/#predictions`);
    await page.getByPlaceholder(/search/i).fill(title);
    await page.getByText(title, { exact: false }).first().click();

    const card = page.locator('.outcome-market-card');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator('.outcome-row')).toHaveCount(2);

    const alphaRow = card.locator('.outcome-row', { hasText: 'Alpha' });
    await expect(alphaRow.locator('.outcome-prob')).toHaveText(/50\.0%/);
    await alphaRow.click();

    await card.locator('.stake-input').fill('100');
    await card.getByRole('button', { name: /^buy$/i }).click();

    // The success toast is transient (the post-trade list refresh remounts the
    // card), so assert persistent state: a position exists and the price moved.
    await expect(card.locator('.user-position')).toBeVisible({ timeout: 10000 });
    await expect(alphaRow.locator('.outcome-prob')).not.toHaveText(/50\.0%/);

    // Expire the hold period for this event directly in the DB so the sell
    // works regardless of the engine's MARKET_ENABLE_HOLD_PERIOD setting.
    psql(`UPDATE market_outcome_updates SET hold_until = NOW() - INTERVAL '1 minute'
          WHERE event_id = ${eventId}`);

    // Sell it all back.
    page.on('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: /sell \(/i }).click();
    await expect(card.locator('.user-position')).not.toBeVisible({ timeout: 10000 });
    await expect(card.getByRole('button', { name: /sell \(0\.00\)/i })).toBeDisabled();
  });
});
