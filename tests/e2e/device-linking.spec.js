// Device linking E2E (Solid).
//
// A second browser profile on the same account must not be able to fetch the
// vault master key (LINK_REQUIRED) until a trusted device approves it. Drives
// the real approval surfaces on both sides: the DeviceLinkModal token display
// on the new device and the settings DeviceManager approve form on the
// trusted one.
//
// Environment requirements are the same as solid-messaging.spec.js (Solid
// frontend on SOLID_URL, docker DB access for provisioning/cleanup).

const { test, expect } = require('@playwright/test');
const {
  PASSWORD,
  dbQuery,
  createUser,
  provisionTier,
  provisionTopics,
  loginOnSolid,
  provisionMessaging,
  cleanupUsers
} = require('./helpers/solidMessaging');

async function attemptVaultUnlock(page, userId) {
  return page.evaluate(async ({ password, userId }) => {
    const vaultService = window.__vaultService || window.vaultService
      || (await import('/src/services/mls/vaultService.js').catch(() => null))?.default;
    if (!vaultService) return { error: 'vaultService unavailable' };
    const vaultStore = window.__vaultStore
      || (await import('/src/store/vaultStore.js').catch(() => null))?.default;
    vaultStore?.setUserId?.(userId);
    vaultService.setUserId?.(userId);
    try {
      await vaultService.unlockWithPassword(password);
      return { unlocked: true };
    } catch (err) {
      // findAndUnlock flattens failures into a generic message; probe the
      // master-key fetch directly (the same call it makes) so the spec can
      // assert on the backend's LINK_REQUIRED response.
      try {
        await vaultService.getOrCreateMasterKey(password, { createIfMissing: false });
        return { unlocked: false, message: err?.message || String(err) };
      } catch (keyErr) {
        return {
          unlocked: false,
          status: keyErr?.status ?? null,
          code: keyErr?.data?.code ?? keyErr?.code ?? null,
          message: keyErr?.message || String(keyErr)
        };
      }
    }
  }, { password: PASSWORD, userId });
}

test.describe('Device linking E2E', () => {
  test('second browser requires approval from the trusted device, then unlocks', async ({ browser }) => {
    test.setTimeout(240000);

    const user = await createUser('dl');
    provisionTier(user);
    await provisionTopics(user);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // Device A: first browser session registers the implicitly-trusted
      // first device during keystore setup.
      await loginOnSolid(pageA, user);
      await provisionMessaging(pageA, user);

      // Device A's settings expose the device-linking tools. Navigate via
      // hash (not page.goto — a reload would re-lock the vault in memory).
      await pageA.evaluate(() => { window.location.hash = '#settings'; });
      await expect(pageA.getByRole('heading', { name: 'Linked Devices' })).toBeVisible({ timeout: 15000 });

      // If the vault shows as locked here (e.g. state settled after a
      // remount), unlock through DeviceManager's own form.
      const unlockVaultButton = pageA.getByRole('button', { name: 'Unlock Vault' });
      if (await unlockVaultButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await pageA.locator('.device-manager').getByPlaceholder('Password').fill(PASSWORD);
        await unlockVaultButton.click();
        await expect(unlockVaultButton).toBeHidden({ timeout: 15000 });
      }
      await expect(pageA.getByPlaceholder('Enter device code')).toBeVisible({ timeout: 15000 });
      await expect(pageA.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();

      // Device B: clean browser, same account. The master key endpoint must
      // refuse it until the device is linked.
      await loginOnSolid(pageB, user);
      const denied = await attemptVaultUnlock(pageB, user.id);
      expect(denied.unlocked, `unlock should be denied: ${JSON.stringify(denied)}`).toBe(false);
      expect(denied.status).toBe(403);
      expect(denied.code).toBe('LINK_REQUIRED');

      // Open the device-link modal the same way the messaging UI does on a
      // LINK_REQUIRED error; it self-starts the linking flow and shows the
      // pairing code.
      await pageB.evaluate(async () => {
        const vaultStore = window.__vaultStore
          || (await import('/src/store/vaultStore.js').catch(() => null))?.default;
        vaultStore.setShowDeviceLinkModal(true);
      });
      const modal = pageB.locator('[role="dialog"][aria-label="Link device"]');
      await expect(modal).toBeVisible({ timeout: 15000 });
      await expect(modal.locator('code')).not.toBeEmpty({ timeout: 15000 });

      // The human flow: read the shortened pairing code off the new device's
      // screen and type it on the trusted device. The backend accepts it as
      // an unambiguous prefix of the pending token.
      const displayedCode = (await modal.locator('code').innerText()).trim();
      expect(displayedCode).toMatch(/^[A-F0-9]{3}(-[A-F0-9]{3}){3}$/i);

      // Device A approves through the real settings form using that code.
      await pageA.getByPlaceholder('Enter device code').fill(displayedCode);
      await pageA.getByPlaceholder('Approver password').fill(PASSWORD);
      pageA.once('dialog', (dialog) => dialog.accept());
      await pageA.getByRole('button', { name: 'Approve', exact: true }).click();

      // Device B's modal polls the linking status and closes on approval,
      // persisting the approved device id (scoped per account).
      await expect(modal).toBeHidden({ timeout: 30000 });
      await expect
        .poll(() => pageB.evaluate(
          (userId) => localStorage.getItem(`device_public_id:${userId}`),
          user.id
        ), { timeout: 15000, message: 'approved device id persisted' })
        .not.toBeNull();

      // A freshly linked device has no local keystore yet; the product flow
      // is keystore setup, which must now reuse the approved id and be
      // allowed to fetch the master key. provisionMessaging models exactly
      // that (setup -> MLS bootstrap -> key packages).
      await provisionMessaging(pageB, user);

      // Both devices are registered against the account.
      const deviceCount = Number(dbQuery(
        `SELECT COUNT(*) FROM user_devices WHERE user_id = ${user.id} AND revoked_at IS NULL;`
      ));
      expect(deviceCount).toBeGreaterThanOrEqual(2);
    } finally {
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
      cleanupUsers([user]);
    }
  });
});
