const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('user search finds a user and follows from results', async ({ page }) => {
  const a = await createUser('tsearch1a');
  const b = await createUser('tsearch1b');
  created.push(a, b);

  await page.addInitScript((t) => localStorage.setItem('token', t), a.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#search`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="search"]');
  await expect(view).toBeVisible({ timeout: 15000 });

  await view.locator('[data-testid="search-input"]').fill(b.username);
  const row = view.locator('[data-testid="search-user-row"]', { hasText: b.username });
  await expect(row).toBeVisible({ timeout: 10000 });

  await row.locator('[data-testid="search-follow"]').click();
  await expect(row.locator('[data-testid="search-follow"]')).toContainText('[UNFOLLOW]', { timeout: 10000 });
});
