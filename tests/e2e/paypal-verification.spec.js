// PayPal Tier-3 verification staging smoke (vault setup-token flow).
//
// Drives the real redirect round trip: settings -> Verify with PayPal ->
// sandbox PayPal login + approval -> return to #settings -> synchronous
// confirm -> tier 3 (webhook lands as idempotent backup).
//
// Requires a FRESH tier-2 user per run (a tier-3 user no longer renders the
// payment step) plus a PayPal sandbox buyer account:
//   PAYPAL_VERIFICATION_E2E=1
//   PAYPAL_VERIFICATION_E2E_USER_EMAIL / _PASSWORD    (tier-2 app user)
//   PAYPAL_SANDBOX_BUYER_EMAIL / _PASSWORD            (sb-...@personal.example.com)

const { test, expect } = require('@playwright/test');

const ENABLED = process.env.PAYPAL_VERIFICATION_E2E === '1';
const USER_EMAIL = process.env.PAYPAL_VERIFICATION_E2E_USER_EMAIL || '';
const USER_PASSWORD = process.env.PAYPAL_VERIFICATION_E2E_USER_PASSWORD || '';
const BUYER_EMAIL = process.env.PAYPAL_SANDBOX_BUYER_EMAIL || '';
const BUYER_PASSWORD = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD || '';

test.describe('PayPal verification staging smoke', () => {
  test.skip(
    !ENABLED || !USER_EMAIL || !USER_PASSWORD || !BUYER_EMAIL || !BUYER_PASSWORD,
    'Set PAYPAL_VERIFICATION_E2E=1 plus app-user and sandbox-buyer credentials to run.'
  );

  test('tier-2 user completes PayPal vault approval through to the tier upgrade', async ({ page }) => {
    test.setTimeout(180000);

    await page.goto('/#login');
    await page.fill('#email', USER_EMAIL);
    await page.fill('#password', USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await Promise.race([
      page.waitForFunction(() => window.location.hash === '#home', { timeout: 15000 }),
      page.waitForSelector('.feed-panel, .home-page', { state: 'visible', timeout: 15000 })
    ]);

    await page.goto('/#settings');
    await page.waitForSelector('.verification-settings, .verification-status', { timeout: 15000 });

    const paypalButton = page.getByRole('button', { name: /Verify with PayPal/i });
    await expect(paypalButton).toBeVisible({ timeout: 15000 });
    await paypalButton.click();

    // Full-page redirect to the PayPal sandbox approval flow.
    await page.waitForURL(/sandbox\.paypal\.com/, { timeout: 45000 });

    // Sandbox login (email -> Next -> password -> Log In); tolerate the
    // one-page variant where both fields are visible at once.
    const emailField = page.locator('#email');
    await emailField.waitFor({ state: 'visible', timeout: 45000 });
    await emailField.fill(BUYER_EMAIL);
    const nextButton = page.locator('#btnNext');
    if (await nextButton.isVisible().catch(() => false)) {
      await nextButton.click();
    }
    const passwordField = page.locator('#password');
    await passwordField.waitFor({ state: 'visible', timeout: 30000 });
    await passwordField.fill(BUYER_PASSWORD);
    await page.locator('#btnLogin').click();

    // Approve saving the payment method. Button copy varies by experiment.
    const approveButton = page.getByRole('button', {
      name: /Agree|Continue|Save|Zustimmen|Weiter|Speichern/i
    }).first();
    await approveButton.waitFor({ state: 'visible', timeout: 60000 });
    await approveButton.click();

    // Back in the app: the pending setup token confirms on mount.
    await page.waitForURL(/#settings/, { timeout: 60000 });
    await expect(page.getByText('Payment method verified.', { exact: true }))
      .toBeVisible({ timeout: 30000 })
      .catch(() => {}); // transient — the authoritative check is below

    await expect
      .poll(async () => page.evaluate(async () => {
        const res = await fetch('/api/verification/status', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await res.json();
        return { tier: data.current_tier, payment: data.payment_verified };
      }), { timeout: 120000, message: 'PayPal confirm upgraded user to tier 3' })
      .toMatchObject({ tier: 3, payment: true });
  });
});
