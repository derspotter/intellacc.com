// E2E: multi-outcome trading loop.
// Seeds a multiple_choice event directly in the DB, then drives the UI:
// select event -> pick outcome -> buy -> price shifts -> sell -> position gone.
const { test, expect } = require('@playwright/test');
const { execSync } = require('child_process');

const psql = (sql) =>
  execSync(
    `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();

test.describe('multi-outcome trading', () => {
  let eventId;
  const title = `E2E MC market ${Date.now()}`;

  test.beforeAll(() => {
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
    if (eventId) psql(`DELETE FROM events WHERE id = ${eventId}`);
  });

  test('buy then sell an outcome via the UI', async ({ page }) => {
    await page.goto('http://localhost:4174/#login');
    await page.getByLabel(/email/i).fill('user1@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /log in/i }).click();
    await page.waitForURL(/#(home|feed)/, { timeout: 15000 });

    await page.goto('http://localhost:4174/#predictions');
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
    await expect(card.locator('.success')).toContainText(/bought/i, { timeout: 10000 });

    // Price moved off 50% and a position exists.
    await expect(alphaRow.locator('.outcome-prob')).not.toHaveText(/50\.0%/);
    await expect(card.locator('.user-position')).toBeVisible();

    // Sell it all back.
    page.on('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: /sell \(/i }).click();
    await expect(card.locator('.success')).toContainText(/sold/i, { timeout: 10000 });
    await expect(card.locator('.user-position')).not.toBeVisible();
  });
});
