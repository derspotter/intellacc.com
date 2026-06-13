// Topic onboarding gate journey.
//
// A logged-in user with zero `user_topics` rows is blocked behind the
// `.topic-picker` instead of normal page content. Picking >= 3 topics and
// hitting Continue saves the selection and reveals the page; a reload must
// NOT re-show the picker. This spec also serves as the real-browser
// verification for the topic picker, discover feed, and weekly card work.
//
// Requirements (same as the Solid messaging specs):
// - Solid frontend reachable at SOLID_URL (default http://127.0.0.1:4174,
//   e.g. `docker compose -p solid-local -f docker-compose.solid-local.yml up -d`).
//   The Vite server proxies /api to the backend, so no separate backend URL
//   is needed by default.
// - Database container reachable via `docker exec` for test-user cleanup.

const { test, expect } = require('@playwright/test');
const {
  SOLID_URL,
  createUser,
  provisionTier,
  captureClientLogs,
  cleanupUsers
} = require('./helpers/solidMessaging');

test.describe('Topic onboarding gate', () => {
  let user;

  test.afterAll(() => {
    cleanupUsers(user ? [user] : []);
  });

  test('new user is gated by the topic picker until they pick topics', async ({ browser }) => {
    test.setTimeout(120000);

    // A freshly registered user has zero user_topics rows, so the gate fires.
    user = await createUser('topics');
    provisionTier(user);

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      captureClientLogs(page, user);

      // Boot authenticated straight onto the home route. checkTopics() runs on
      // mount, sees zero topics, and raises the blocking gate.
      await page.addInitScript((token) => localStorage.setItem('token', token), user.token);
      await page.goto(`${SOLID_URL}/#home`, { waitUntil: 'domcontentloaded' });

      // 1. The picker blocks the page.
      const picker = page.locator('.topic-picker');
      await expect(picker).toBeVisible({ timeout: 30000 });
      // Normal home content is NOT rendered while gated.
      await expect(page.locator('.home-page')).toHaveCount(0);

      // 2. Continue is disabled before three topics are selected. Wait for the
      // options to load first (the picker fetches topics via the API).
      const options = page.locator('.topic-option');
      await expect(options.first()).toBeVisible({ timeout: 30000 });
      const continueButton = page.locator('.topic-picker-actions button');
      await expect(continueButton).toBeDisabled();

      // 3. Pick exactly three topics; Continue then enables.
      for (let i = 0; i < 3; i += 1) {
        await options.nth(i).click();
      }
      await expect(continueButton).toBeEnabled();
      await continueButton.click();

      // 4. The picker disappears and normal home content renders.
      await expect(picker).toHaveCount(0, { timeout: 30000 });
      await expect(page.locator('.home-page')).toBeVisible({ timeout: 30000 });

      // 5. Reload: the user now has topics, so the gate must not reappear.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('.home-page')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.topic-picker')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
