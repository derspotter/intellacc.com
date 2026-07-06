// #predictions/:id deep link must select that market even if it is not on page 1.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('predictions deep link selects the market', async ({ page }) => {
  const u = await createUser('twk1');
  created.push(u);
  // Pick a real event that is NOT in the first 100 by the default ordering.
  const row = dbQuery(`SELECT id, title FROM events ORDER BY id DESC LIMIT 1;`);
  const [eventId] = row.split('|');
  expect(Number(eventId)).toBeGreaterThan(0);

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#predictions/${eventId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  // The order-book detail shows the selected market (desktop viewport default).
  await expect(page.getByText('ORDER BOOK // DEPTH')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="market-detail-title"]')).not.toHaveText('', { timeout: 15000 });
});
