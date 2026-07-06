// Terminal analytics view: summary tiles, activity, positions, persuasion.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('analytics view renders summary tiles', async ({ page }) => {
  const u = await createUser('tana1');
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#analytics`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="analytics"]');
  await expect(view).toBeVisible({ timeout: 15000 });
  await expect(view.locator('[data-testid="analytics-summary"]')).toBeVisible({ timeout: 15000 });
  await expect(view).toContainText('TOTAL PREDICTIONS');
  await expect(view).toContainText('ACCURACY');
});
