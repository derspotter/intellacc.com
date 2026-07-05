const { test, expect } = require('@playwright/test');

// Mobile navigation smoke: at phone width the sidebar is off-canvas and the
// bottom tab bar is the primary nav. Runs logged out — nav must work for
// invited users before they authenticate.

const MOBILE = { width: 390, height: 844 };

const TABS = [
  { label: 'Home', hash: '#home' },
  { label: 'Markets', hash: '#predictions' },
  { label: 'Alerts', hash: '#notifications' },
  { label: 'Messages', hash: '#messages' }
];

test.describe('mobile bottom nav', () => {
  test.use({ viewport: MOBILE });

  test.beforeEach(async ({ page }) => {
    await page.goto('/#home');
    await page.waitForSelector('.mobile-tab-bar');
  });

  test('tab bar is visible and sidebar is off-canvas', async ({ page }) => {
    await expect(page.locator('.mobile-tab-bar')).toBeVisible();
    const sidebarX = await page
      .locator('.sidebar')
      .evaluate((el) => el.getBoundingClientRect().x);
    expect(sidebarX).toBeLessThan(0);
  });

  test('each tab routes to its page without horizontal overflow', async ({ page }) => {
    const bar = page.locator('.mobile-tab-bar');
    for (const { label, hash } of TABS) {
      await bar.getByRole('link', { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`${hash}$`));
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(overflow, `${label} page must not scroll horizontally`).toBe(false);
    }
  });

  test('More opens the sidebar drawer; backdrop and navigation close it', async ({ page }) => {
    const more = page.getByRole('button', { name: 'More', exact: true });
    const sidebar = page.locator('.sidebar');

    await more.click();
    await expect(sidebar).toHaveClass(/open/);

    await page.locator('.sidebar-backdrop').click({ position: { x: 350, y: 400 } });
    await expect(sidebar).not.toHaveClass(/open/);

    await more.click();
    await expect(sidebar).toHaveClass(/open/);
    await sidebar.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/#settings$/);
    await expect(sidebar).not.toHaveClass(/open/);
  });

  test('tab bar is hidden on desktop widths', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('.mobile-tab-bar')).toBeHidden();
    const sidebarX = await page
      .locator('.sidebar')
      .evaluate((el) => el.getBoundingClientRect().x);
    expect(sidebarX).toBeGreaterThanOrEqual(0);
  });
});
