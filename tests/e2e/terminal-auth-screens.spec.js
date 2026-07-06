const { test, expect } = require('@playwright/test');
const { SOLID_URL } = require('./helpers/solidMessaging');

test('logged-out forgot-password screen renders and submits', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#forgot-password`, { waitUntil: 'domcontentloaded' });
  const screen = page.locator('[data-auth-screen="forgot-password"]');
  await expect(screen).toBeVisible({ timeout: 15000 });
  await screen.locator('input[type="email"]').fill(`nosuch_${Date.now()}@example.com`);
  await screen.getByRole('button', { name: /SEND RESET LINK/i }).click();
  await expect(screen).toContainText(/RESET LINK|IF AN ACCOUNT EXISTS/i, { timeout: 10000 });
});

test('reset screen without token shows invalid state', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#reset-password`, { waitUntil: 'domcontentloaded' });
  const screen = page.locator('[data-auth-screen="reset-password"]');
  await expect(screen).toBeVisible({ timeout: 15000 });
  await expect(screen).toContainText(/INVALID|MISSING/i);
});

test('login modal links to forgot password', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  // Advance to the password stage (identifier first).
  await page.locator('input').first().fill('someone@example.com');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /FORGOT PASSWORD/i }).click();
  await expect(page.locator('[data-auth-screen="forgot-password"]')).toBeVisible({ timeout: 10000 });
});

test('verify-email without token shows error state', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#verify-email`, { waitUntil: 'domcontentloaded' });
  const screen = page.locator('[data-auth-screen="verify-email"]');
  await expect(screen).toBeVisible({ timeout: 15000 });
  await expect(screen).toContainText(/INVALID|MISSING|FAILED/i, { timeout: 10000 });
});
