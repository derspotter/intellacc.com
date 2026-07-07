// E2E: van-skin modal dialogs (Task 3 of the keyboard-navigation plan).
// LoginModal and DeviceLinkModal must behave as real dialogs: role="dialog",
// aria-modal, focus enters on open, Tab is trapped inside, and Escape closes
// (where the modal has a dismiss action at all — see the LoginModal note
// below).
//
// This file is intentionally separate from tests/e2e/keyboard-navigation.spec.js
// (owned by another concurrent workstream) even though it covers adjacent
// ground.
const { test, expect } = require('@playwright/test');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';

const login = async (page) => {
  await page.goto(`${BASE}/#login`);
  await page.getByLabel(/email/i).fill('user1@example.com');
  await page.getByLabel(/password/i).fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/#(home|feed)/, { timeout: 15000 });
};

test.describe('modal keyboard behavior', () => {
  test('device link modal: focus lands inside, Tab stays trapped, Escape closes', async ({ page }) => {
    // DeviceLinkModal (frontend-solid/src/components/vault/DeviceLinkModal.jsx)
    // is only ever opened by real MLS "device link required" errors in
    // MessagesPage/ChatPanel, which need real vault/device backend state to
    // trigger through the UI. vaultStore exposes itself on
    // `window.__vaultStore` unconditionally (see store/vaultStore.js) for
    // exactly this kind of test hook, so we drive the modal's visibility
    // directly rather than fabricating a device-link-required error.
    await login(page);
    await page.goto(`${BASE}/#messages`);

    await page.evaluate(() => window.__vaultStore.setShowDeviceLinkModal(true));

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-label', 'Link device');

    const focusInside = await page.evaluate(() =>
      document.querySelector('[role="dialog"]').contains(document.activeElement)
    );
    expect(focusInside).toBe(true);

    // Tab from the last focusable element cycles back to the first instead
    // of leaving the dialog (createFocusTrap in utils/keyboard.js).
    const wrapped = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const focusable = [...dlg.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((el) => el.offsetParent !== null);
      focusable[focusable.length - 1].focus();
      return focusable.length > 0;
    });
    expect(wrapped).toBe(true);
    await page.keyboard.press('Tab');
    const focusInsideAfterTab = await page.evaluate(() =>
      document.querySelector('[role="dialog"]').contains(document.activeElement)
    );
    expect(focusInsideAfterTab).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('login modal: rendered as a real dialog with focus trapped inside (no dismiss action by design)', async ({ page }) => {
    // LoginModal (frontend-solid/src/components/auth/LoginModal.jsx) is only
    // ever rendered by the terminal skin (TerminalApp.jsx), and only while
    // logged out — it is a hard gate, not a cancelable overlay, so unlike
    // DeviceLinkModal there is no "Escape closes" assertion here: the
    // component intentionally treats Escape as a no-op (see the comment in
    // LoginModal.jsx). We still verify the dialog semantics and focus
    // management that Task 3 requires.
    await page.goto(`${BASE}/#home?skin=terminal`);
    await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-label', 'Sign in');

    const focusInside = await page.evaluate(() =>
      document.querySelector('[role="dialog"]').contains(document.activeElement)
    );
    expect(focusInside).toBe(true);

    // Escape is intentionally inert here: it must neither close the dialog
    // nor throw.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  });
});
