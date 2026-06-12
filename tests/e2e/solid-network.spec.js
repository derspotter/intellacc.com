// Network page: the 3D follow graph renders (or degrades gracefully without
// WebGL) and exposes graph stats. Environment as in solid-messaging.spec.js.

const { test, expect } = require('@playwright/test');
const {
  apiFetch,
  createUser,
  loginOnSolid,
  cleanupUsers
} = require('./helpers/solidMessaging');

test.describe('Solid network page', () => {
  test('renders the follow graph with stats', async ({ browser }) => {
    test.setTimeout(120000);

    const alice = await createUser('gnalice');
    const bob = await createUser('gnbob');
    const follow = await apiFetch(`/api/users/${alice.id}/follow`, { method: 'POST', token: bob.token });
    if (!follow.response.ok) throw new Error(`follow failed: ${follow.text}`);

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await loginOnSolid(page, alice);
      await page.evaluate(() => { window.location.hash = '#network'; });

      // Stats panel proves the graph endpoint returned data.
      await expect(page.locator('.network-stats')).toContainText(/\d+ users · \d+ follows/, { timeout: 30000 });

      // Either the WebGL canvas mounts (lazy three.js chunk) or the graceful
      // no-WebGL fallback is shown.
      await expect(
        page.locator('.social-graph-container canvas, .social-graph-container .network-hint').first()
      ).toBeVisible({ timeout: 30000 });
    } finally {
      await context.close();
      cleanupUsers([alice, bob]);
    }
  });
});
