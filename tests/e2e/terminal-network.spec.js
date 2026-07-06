// Terminal skin NETWORK view: the follow graph rendered as a sortable table
// (no three.js — the van page's 3D graph is a heavy dependency we keep out
// of the terminal bundle entirely).
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('network view renders the graph as a table, never loads three.js', async ({ page }) => {
  const u = await createUser('tnet1');
  created.push(u);

  // Register the request listener BEFORE navigating so a 3D chunk requested
  // during initial page load would actually be caught.
  // Match the three.js package/chunk itself or the 3D component, but not
  // unrelated names like ThreePaneLayout.jsx (the terminal skin's own layout).
  const threeRequests = [];
  page.on('request', (r) => { if (/\bthree\b|node_modules\/three|SocialGraph3D/i.test(r.url())) threeRequests.push(r.url()); });

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#network`, { waitUntil: 'domcontentloaded' });

  const view = page.locator('[data-view="network"]');
  await expect(view).toBeVisible({ timeout: 15000 });
  await expect(view).toContainText('[VIEW] NETWORK');
  // Rows or the explicit empty state — never blank.
  await expect(view.locator('[data-testid="network-row"], [data-testid="network-empty"]').first())
    .toBeVisible({ timeout: 15000 });

  await page.waitForTimeout(1000);
  expect(threeRequests).toHaveLength(0);
});

test('network view requires sign-in', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#network`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="network"]');
  await expect(view).toBeVisible({ timeout: 15000 });
  await expect(view).toContainText('SIGN IN TO EXPLORE THE NETWORK');
});
