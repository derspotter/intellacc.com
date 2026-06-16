// Regression: the terminal (Bloomberg) skin must offer a way back to the van
// skin. Previously TerminalApp imported only getActiveSkin (no setter), so once
// in terminal there was no affordance to switch back.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('terminal skin offers a way back to van', async ({ page }) => {
  const u = await createUser('skinback');
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  // ?skin=terminal forces the terminal skin regardless of account preference.
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  const vanBtn = page.getByRole('button', { name: '[VAN]' });
  await expect(vanBtn).toBeVisible({ timeout: 10000 });
  await vanBtn.click();

  await expect(page.locator('body')).toHaveAttribute('data-skin', 'van', { timeout: 10000 });
  await expect(page.locator('a[href="#network"]').first()).toBeVisible({ timeout: 10000 });
});
