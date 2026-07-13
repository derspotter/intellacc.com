const { test, expect } = require('@playwright/test');

const PAYMENT_E2E_ENABLED = process.env.PAYMENT_VERIFICATION_E2E === '1';
const STAGING_USER_EMAIL = process.env.PAYMENT_VERIFICATION_E2E_USER_EMAIL || '';
const STAGING_USER_PASSWORD = process.env.PAYMENT_VERIFICATION_E2E_USER_PASSWORD || '';

test.describe('Payment verification staging smoke', () => {
  test.skip(
    !PAYMENT_E2E_ENABLED || !STAGING_USER_EMAIL || !STAGING_USER_PASSWORD,
    'Set PAYMENT_VERIFICATION_E2E=1 plus PAYMENT_VERIFICATION_E2E_USER_EMAIL/PASSWORD to run staging payment verification smoke.'
  );

  test('tier-2 user completes Stripe payment verification through to the webhook tier upgrade', async ({ page }) => {
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

    // Complete the SetupIntent with Stripe's standard test card inside the
    // Payment Element iframe. Field set varies by account country/config, so
    // fill by accessible name and skip fields that are not rendered.
    const frame = page.frameLocator('.payment-form-body iframe').first();
    await frame.getByRole('textbox', { name: 'Card number' }).fill('4242424242424242');
    await frame.getByRole('textbox', { name: /Expiration/ }).fill('12/34');
    await frame.getByRole('textbox', { name: 'Security code' }).fill('123');
    for (const [label, value] of [
      ['Full name', 'E2E Test'],
      [/Postal code|ZIP/, '10115']
    ]) {
      const field = frame.getByRole('textbox', { name: label }).first();
      if (await field.isVisible().catch(() => false)) {
        await field.fill(value);
      }
    }

    // Note: the "Payment method verified." success state is transient — the
    // parent refreshes status on success and re-renders the step — so assert
    // on the authoritative signals below instead of the flash.
    await page.getByRole('button', { name: /Confirm verification/i }).click();

    // The tier upgrade lands via the setup_intent.succeeded webhook — poll
    // the status endpoint until Stripe's delivery arrives.
    await expect
      .poll(async () => page.evaluate(async () => {
        const res = await fetch('/api/verification/status', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await res.json();
        return { tier: data.current_tier, payment: data.payment_verified };
      }), { timeout: 120000, message: 'webhook upgraded user to tier 3' })
      .toMatchObject({ tier: 3, payment: true });

    // Fully verified: settings no longer offers the payment step.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.goto('/#settings');
    await page.waitForSelector('.verification-settings, .verification-status', { timeout: 15000 });
    await expect(page.getByRole('button', { name: /Start payment verification/i })).toHaveCount(0);
  });
});
