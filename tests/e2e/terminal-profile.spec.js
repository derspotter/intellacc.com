// Terminal-native profile view: own profile stats + other-user follow flow.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

async function loginTerminal(page, u) {
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
}

test('own profile shows stats grid', async ({ page }) => {
  const u = await createUser('tprof1');
  created.push(u);
  await loginTerminal(page, u);

  await page.evaluate(() => { window.location.hash = '#profile'; });
  const view = page.locator('[data-view="profile"]');
  await expect(view).toBeVisible({ timeout: 10000 });
  await expect(view).toContainText(`@${u.username}`);
  await expect(view.locator('[data-testid="profile-stat-balance"]')).toContainText(/RP/);
  await expect(view.locator('[data-testid="profile-stat-reputation"]')).toContainText(/RP/);
});

test('other-user profile follows and unfollows', async ({ page }) => {
  const a = await createUser('tprof2a');
  const b = await createUser('tprof2b');
  created.push(a, b);
  await loginTerminal(page, a);

  await page.evaluate((id) => { window.location.hash = `#user/${id}`; }, String(b.id));
  const view = page.locator('[data-view="user"]');
  await expect(view).toBeVisible({ timeout: 10000 });
  await expect(view).toContainText(`@${b.username}`);

  const followBtn = view.locator('[data-testid="profile-follow"]');
  await expect(followBtn).toContainText('[FOLLOW]', { timeout: 10000 });
  await followBtn.click();
  await expect(followBtn).toContainText('[UNFOLLOW]', { timeout: 10000 });
  await followBtn.click();
  await expect(followBtn).toContainText('[FOLLOW]', { timeout: 10000 });
});
