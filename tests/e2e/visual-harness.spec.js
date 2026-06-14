// Component-isolation visual baselines (dev-only #__harness route). Deterministic
// fixtures → no auth, no masking. See
// docs/superpowers/specs/2026-06-14-component-isolation-harness-design.md
// Update baselines: npx playwright test tests/e2e/visual-harness.spec.js --update-snapshots=all
const { test, expect } = require('@playwright/test');
const { SOLID_URL } = require('./helpers/solidMessaging');

test('postitem gallery', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${SOLID_URL}/#__harness`, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-harness="postitem"] .posts-list')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page).toHaveScreenshot('postitem-gallery.png', { fullPage: true });
});
