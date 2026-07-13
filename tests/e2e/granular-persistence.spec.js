// Granular MLS persistence E2E (Solid).
//
// The vault persists MLS state as individually encrypted granular events in
// IndexedDB (intellacc_keystore/mls_granular_storage). This spec verifies the
// store is created and populated by messaging provisioning, that every record
// is ciphertext, that it survives a page reload, and that wipeMemory() clears
// the in-memory client on logout.

const { test, expect } = require('@playwright/test');
const {
  createUser,
  provisionTier,
  provisionTopics,
  loginOnSolid,
  provisionMessaging,
  cleanupUsers
} = require('./helpers/solidMessaging');

async function getGranularStorageStats(page) {
  return page.evaluate(async () => {
    const dbs = await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]));
    if (!dbs.some((db) => db.name === 'intellacc_keystore')) {
      return { dbExists: false, stores: [], granularEventCount: 0, keystoreRecordCount: 0 };
    }
    return new Promise((resolve) => {
      const request = indexedDB.open('intellacc_keystore');
      request.onerror = () => resolve({ error: 'Failed to open DB' });
      request.onsuccess = () => {
        const db = request.result;
        const stores = Array.from(db.objectStoreNames);
        if (!stores.includes('mls_granular_storage') || !stores.includes('device_keystore')) {
          db.close();
          return resolve({ dbExists: true, stores, granularEventCount: 0, keystoreRecordCount: 0 });
        }
        const tx = db.transaction(['mls_granular_storage', 'device_keystore'], 'readonly');
        const granularReq = tx.objectStore('mls_granular_storage').count();
        const keystoreReq = tx.objectStore('device_keystore').count();
        let granularEventCount = 0;
        let keystoreRecordCount = 0;
        granularReq.onsuccess = () => { granularEventCount = granularReq.result; };
        keystoreReq.onsuccess = () => { keystoreRecordCount = keystoreReq.result; };
        tx.oncomplete = () => {
          db.close();
          resolve({ dbExists: true, stores, granularEventCount, keystoreRecordCount });
        };
      };
    });
  });
}

async function getGranularEventDetails(page) {
  return page.evaluate(async () => {
    return new Promise((resolve) => {
      const request = indexedDB.open('intellacc_keystore');
      request.onerror = () => resolve({ categories: [], details: [] });
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('mls_granular_storage')) {
          db.close();
          return resolve({ categories: [], details: [] });
        }
        const tx = db.transaction('mls_granular_storage', 'readonly');
        const req = tx.objectStore('mls_granular_storage').getAll();
        req.onsuccess = () => {
          const records = req.result || [];
          db.close();
          resolve({
            categories: [...new Set(records.map((r) => r.category))],
            details: records.map((r) => ({
              id: r.id,
              category: r.category,
              hasEncryptedValue: !!r.encryptedValue
            }))
          });
        };
        req.onerror = () => {
          db.close();
          resolve({ categories: [], details: [] });
        };
      };
    });
  });
}

test.describe('Granular MLS persistence E2E', () => {
  test('provisioning populates encrypted granular storage; persists across reload; wipes from memory', async ({ browser }) => {
    test.setTimeout(180000);

    const user = await createUser('gp');
    provisionTier(user);
    await provisionTopics(user);

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await loginOnSolid(page, user);

      // Fresh browser context: no granular events yet.
      const before = await getGranularStorageStats(page);
      expect(before.granularEventCount).toBe(0);

      await provisionMessaging(page, user);

      const after = await getGranularStorageStats(page);
      expect(after.dbExists).toBe(true);
      expect(after.stores).toContain('mls_granular_storage');
      expect(after.stores).toContain('device_keystore');
      expect(after.granularEventCount).toBeGreaterThan(0);
      expect(after.keystoreRecordCount).toBeGreaterThanOrEqual(1);

      const events = await getGranularEventDetails(page);
      expect(events.categories).toContain('key_package');
      expect(events.details.length).toBeGreaterThan(0);
      for (const detail of events.details) {
        expect(detail.hasEncryptedValue, `record ${detail.id} must be encrypted`).toBe(true);
      }

      // IndexedDB persistence across a reload (simulated browser restart —
      // the vault re-locks in memory, but the encrypted state remains).
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const reloaded = await getGranularStorageStats(page);
      expect(reloaded.granularEventCount).toBeGreaterThanOrEqual(after.granularEventCount);
      expect(reloaded.keystoreRecordCount).toBe(after.keystoreRecordCount);

      // Logout hygiene: after re-provisioning (the reload re-locked the
      // vault), clicking Logout must lock the vault and wipe the MLS client
      // from memory — not just drop the token. (logout -> lockKeys ->
      // wipeMemory + clearCache, so this also covers the raw wipe path.)
      await loginOnSolid(page, user);
      await provisionMessaging(page, user);
      const beforeLogout = await page.evaluate(() => !!window.coreCryptoClient?.client);
      expect(beforeLogout, 'client alive before logout').toBe(true);

      await page.evaluate(() => { window.location.hash = '#home'; });
      await page.locator('.logout-btn, .nav-btn:has-text("Logout")').first().click();
      await expect
        .poll(() => page.evaluate(() => ({
          token: localStorage.getItem('token'),
          client: !!window.coreCryptoClient?.client,
          locked: window.__vaultStore?.state?.locked === true || window.__vaultStore?.state?.isLocked === true
        })), { timeout: 10000, message: 'logout wipes session' })
        .toMatchObject({ token: null, client: false, locked: true });
    } finally {
      await context.close().catch(() => {});
      cleanupUsers([user]);
    }
  });
});
