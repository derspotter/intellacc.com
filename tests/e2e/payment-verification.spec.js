const { test, expect } = require('@playwright/test');

const PAYMENT_E2E_ENABLED = process.env.PAYMENT_VERIFICATION_E2E === '1';
const STAGING_USER_EMAIL = process.env.PAYMENT_VERIFICATION_E2E_USER_EMAIL || '';
const STAGING_USER_PASSWORD = process.env.PAYMENT_VERIFICATION_E2E_USER_PASSWORD || '';

test.describe('Payment verification staging smoke', () => {
  test.skip(
    !PAYMENT_E2E_ENABLED || !STAGING_USER_EMAIL || !STAGING_USER_PASSWORD,
    'Set PAYMENT_VERIFICATION_E2E=1 plus PAYMENT_VERIFICATION_E2E_USER_EMAIL/PASSWORD to run staging payment verification smoke.'
  );

  test('tier-2 user can mount the Stripe payment verification form', async ({ page }) => {
    test.setTimeout(90000);

    await page.goto('/#login');
    await page.fill('#email', STAGING_USER_EMAIL);
    await page.fill('#password', STAGING_USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await Promise.race([
      page.waitForFunction(() => window.location.hash === '#home', { timeout: 15000 }),
      page.waitForSelector('.feed-panel, .home-page', { state: 'visible', timeout: 15000 })
    ]);

    await page.goto('/#settings');
    await page.waitForSelector('.verification-settings, .verification-status', { timeout: 15000 });

    await expect(page.getByText('Verify a payment method', { exact: false })).toBeVisible({ timeout: 15000 });

    const startButton = page.getByRole('button', { name: /Start payment verification/i });
    await expect(startButton).toBeVisible({ timeout: 15000 });
    await startButton.click();

    await expect(page.getByText('Preparing secure payment form...', { exact: true })).toBeVisible({ timeout: 15000 });

    const paymentFrame = page.locator('.payment-form-body iframe');
    await expect(paymentFrame).toBeVisible({ timeout: 30000 });

    await expect(page.getByRole('button', { name: /Confirm verification/i })).toBeVisible({ timeout: 15000 });
  });
});
