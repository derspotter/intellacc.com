// Terminal skin full-screen views: hash-driven, palette-openable, ESC-closable.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

async function loginTerminal(page, prefix) {
  const u = await createUser(prefix);
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
  return u;
}

test('leaderboard view opens via hash and closes with ESC', async ({ page }) => {
  await loginTerminal(page, 'tview1');

  await page.evaluate(() => { window.location.hash = '#leaderboard'; });
  const view = page.locator('[data-view="leaderboard"]');
  await expect(view).toBeVisible({ timeout: 10000 });
  await expect(view).toContainText('[VIEW] LEADERBOARD');
  // Global tab renders rows or the explicit empty state — never blank.
  await expect(view.locator('[data-testid="leaderboard-rows"], [data-testid="leaderboard-empty"]').first())
    .toBeVisible({ timeout: 10000 });

  await page.keyboard.press('Escape');
  await expect(view).not.toBeVisible();
  expect(new URL(page.url()).hash).toBe('#home');
});

test('command palette opens the leaderboard view', async ({ page }) => {
  await loginTerminal(page, 'tview2');

  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Type a command...').fill('leader');
  await page.getByRole('button', { name: /Open Leaderboard/i }).click();

  await expect(page.locator('[data-view="leaderboard"]')).toBeVisible({ timeout: 10000 });
});

test('RP readout shows in top bar and opens leaderboard', async ({ page }) => {
  await loginTerminal(page, 'tview3');

  const rp = page.locator('[data-testid="rp-readout"]');
  await expect(rp).toBeVisible({ timeout: 10000 });
  await expect(rp).toContainText(/RP:\d/);

  await rp.click();
  await expect(page.locator('[data-view="leaderboard"]')).toBeVisible({ timeout: 10000 });
});

test('top-bar window list escapes an open view', async ({ page }) => {
  await loginTerminal(page, 'tview5');

  // Landing directly on a view route (e.g. after switching skins from van
  // settings) must leave a visible way back to the panes.
  await page.evaluate(() => { window.location.hash = '#settings'; });
  await expect(page.locator('[data-view="settings"]')).toBeVisible({ timeout: 10000 });

  await page.locator('[data-testid="nav-home"]').click();
  await expect(page.locator('[data-view="settings"]')).not.toBeVisible();
  expect(new URL(page.url()).hash).toBe('#home');

  await page.locator('[data-testid="nav-menu"]').click();
  await expect(page.getByPlaceholder('Type a command...')).toBeVisible();
});
