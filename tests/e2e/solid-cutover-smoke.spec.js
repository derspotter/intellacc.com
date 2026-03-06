const { test, expect } = require('@playwright/test');

test.describe('Solid cutover smoke', () => {
  test('login route renders in both skins', async ({ page }) => {
    // 1. Check Van Skin
    await page.goto('/#login?skin=van');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();

    // 2. Check Terminal Skin (multi-stage login modal)
    await page.goto('/#login?skin=terminal');
    // First stage: Email input
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeVisible();
    
    // Advance to password stage to verify full render
    await emailInput.fill('test@test.com');
    await page.locator('button[type="submit"]:has-text("CONTINUE")').click();
    
    // Second stage: Password input
    await expect(page.locator('input[type="password"]')).toBeVisible();
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
