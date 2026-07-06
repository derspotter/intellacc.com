// tests/e2e/skin-preference-sync.spec.js
// The backend has GET/PUT /users/me/preferences but the frontend wrappers
// were missing, so skin choice never synced to the account. After the fix,
// a server-persisted "terminal" preference must apply on a clean visit
// with no ?skin= override and no localStorage.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, apiFetch, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('server-persisted skin preference applies on visit', async ({ page }) => {
  const u = await createUser('tskin1');
  created.push(u);

  const put = await apiFetch('/api/users/me/preferences', {
    method: 'PUT', token: u.token, body: JSON.stringify({ skin: 'terminal' })
  });
  expect(put.response.status).toBe(200);
  expect(put.body.skin).toBe('terminal');

  // Clean visit: token only, no ?skin=, no stored local skin.
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  await page.evaluate(() => { window.location.hash = '#predictions'; });
  await page.waitForTimeout(500);
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal');
});

test('terminal [VAN] button persists the preference server-side', async ({ page }) => {
  const u = await createUser('tskin2');
  created.push(u);

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  await page.getByRole('button', { name: '[VAN]' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'van', { timeout: 10000 });

  await page.evaluate(() => { window.location.hash = '#predictions'; });
  await page.waitForTimeout(500);
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'van');

  await expect.poll(async () => {
    const res = await apiFetch('/api/users/me/preferences', { token: u.token });
    return res.body?.skin;
  }, { timeout: 10000 }).toBe('van');
});
