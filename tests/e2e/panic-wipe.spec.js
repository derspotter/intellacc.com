// Panic wipe E2E (Solid, terminal skin).
//
// vaultService.panicWipe() is LOCAL-DEVICE destruction: it locks the keys,
// deletes the entire intellacc_keystore IndexedDB, and removes the
// device_public_id / device_public_id:<userId> / vault_autolock_minutes
// localStorage keys — server state stays untouched. The terminal skin's
// SettingsView gates the wipe behind a type-"WIPE" confirm input (no
// window.confirm dialogs), then clears the auth token and routes to #home.
//
// This spec provisions a fresh keystore, runs the terminal-skin wipe flow,
// and asserts all of those post-conditions.

const { test, expect } = require('@playwright/test');
const {
  SOLID_URL,
  createUser,
  provisionTier,
  provisionTopics,
  loginOnSolid,
  provisionMessaging,
  cleanupUsers
} = require('./helpers/solidMessaging');

async function getLocalVaultState(page) {
  return page.evaluate(async () => {
    const dbs = await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]));
    return {
      keystoreDbExists: dbs.some((db) => db.name === 'intellacc_keystore'),
      devicePublicIdKeys: Object.keys(localStorage).filter(
        (key) => key === 'device_public_id' || key.startsWith('device_public_id:')
      ),
      autoLockKey: localStorage.getItem('vault_autolock_minutes'),
      token: localStorage.getItem('token'),
      hash: window.location.hash
    };
  });
}

test.describe('Panic wipe E2E (terminal skin)', () => {
  test('type-WIPE gate deletes keystore DB, device ids, and logs out', async ({ browser }) => {
    test.setTimeout(180000);

    const user = await createUser('pw');
    provisionTier(user);
    await provisionTopics(user);

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await loginOnSolid(page, user);
      await provisionMessaging(page, user);

      // Provisioning must have created the local vault footprint.
      const before = await getLocalVaultState(page);
      expect(before.keystoreDbExists, 'keystore DB exists after provisioning').toBe(true);

      // Enter the terminal skin settings view. The full-page navigation
      // re-locks the vault in memory, but the PANIC WIPE control renders
      // regardless of lock state and the encrypted keystore stays on disk.
      await page.goto(`${SOLID_URL}/?skin=terminal#settings`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

      const persisted = await getLocalVaultState(page);
      expect(persisted.keystoreDbExists, 'keystore DB survives navigation').toBe(true);

      // device_public_id* keys are written by the device-LINKING flow, not by
      // first-device keystore setup. Seed them (plus the autolock pref) here so
      // the spec can assert panicWipe removes every vault localStorage key.
      await page.evaluate((userId) => {
        localStorage.setItem('device_public_id', 'e2e-panic-wipe-legacy');
        localStorage.setItem(`device_public_id:${userId}`, 'e2e-panic-wipe-scoped');
        localStorage.setItem('vault_autolock_minutes', '15');
      }, user.id);
      const seeded = await getLocalVaultState(page);
      expect(seeded.devicePublicIdKeys.length, 'seeded device_public_id keys').toBe(2);

      // The type-"WIPE" gate: button stays disabled until the exact word is typed.
      await expect(page.getByText('PANIC WIPE', { exact: true })).toBeVisible({ timeout: 15000 });
      const confirmInput = page.getByPlaceholder('TYPE WIPE TO CONFIRM');
      const wipeButton = page.getByRole('button', { name: '[WIPE VAULT]' });
      await expect(confirmInput).toBeVisible();
      await expect(wipeButton).toBeDisabled();

      await confirmInput.fill('wipe');
      await expect(wipeButton, 'gate must require the exact uppercase word').toBeDisabled();

      await confirmInput.fill('WIPE');
      await expect(wipeButton).toBeEnabled();
      await wipeButton.click();

      // Post-wipe: keystore DB gone, device ids gone, autolock pref gone,
      // token cleared, and the app routed away from settings to #home.
      await expect
        .poll(() => getLocalVaultState(page), { timeout: 20000, message: 'panic wipe post-conditions' })
        .toMatchObject({
          keystoreDbExists: false,
          devicePublicIdKeys: [],
          autoLockKey: null,
          token: null,
          hash: '#home'
        });
    } finally {
      await context.close().catch(() => {});
      cleanupUsers([user]);
    }
  });
});
