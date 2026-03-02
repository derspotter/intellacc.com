const { test, expect } = require('@playwright/test');

test.describe('Solid cutover smoke', () => {
  test('login route renders in both skins', async ({ page }) => {
    await page.goto('/#login?skin=van');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();

    await page.goto('/#login?skin=terminal');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
  });

  test('messaging route shell renders in both skins', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err?.message || err)));

    await page.goto('/#messages?skin=van');
    await expect(page.locator('body')).toContainText(/messages|sign in|unlock/i, { timeout: 15000 });

    await page.goto('/#messages?skin=terminal');
    await expect(page.locator('body')).toContainText(/comms|messages|sign in|unlock/i, { timeout: 15000 });

    expect(pageErrors).toEqual([]);
  });
});
