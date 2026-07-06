const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, apiFetch, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

async function openSettings(page, u) {
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#settings`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="settings"]');
  await expect(view).toBeVisible({ timeout: 15000 });
  return view;
}

test('feed mix saves to the server', async ({ page }) => {
  const u = await createUser('tset1');
  created.push(u);
  const view = await openSettings(page, u);

  // Nudge the first slider, then save.
  const slider = view.locator('input[type="range"]').first();
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await view.locator('[data-testid="settings-feedmix-save"]').click();
  await expect(view).toContainText('SAVED // FEED MIX', { timeout: 10000 });

  const res = await apiFetch('/api/users/me/feed-weights', { token: u.token });
  const w = res.body?.weights;
  expect(w).toBeTruthy();
  expect(w.accuracy + w.followers + w.likes + w.views).toBe(100);
});

test('skin section switches to van and persists', async ({ page }) => {
  const u = await createUser('tset2');
  created.push(u);
  const view = await openSettings(page, u);

  await view.locator('[data-testid="settings-skin-van"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'van', { timeout: 10000 });
  await expect.poll(async () => {
    const res = await apiFetch('/api/users/me/preferences', { token: u.token });
    return res.body?.skin;
  }, { timeout: 10000 }).toBe('van');
});
