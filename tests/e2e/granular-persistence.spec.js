const { test, expect } = require('@playwright/test');

// Test users (must exist in database - see reset-test-users.sh)
const USER1 = { email: 'user1@example.com', password: 'password123', name: 'testuser1' };

/**
 * Clear all browser storage (IndexedDB, localStorage, sessionStorage)
 */
async function clearBrowserStorage(page) {
    // Navigate to the app first so we have access to storage
    await page.goto('/#login');
    await page.waitForTimeout(500);

    await page.evaluate(async () => {
        // Clear localStorage and sessionStorage
        localStorage.clear();
        sessionStorage.clear();

        // Clear all IndexedDB databases and wait for completion
        const databases = await indexedDB.databases();
        const deletePromises = databases.map(db => {
            return new Promise((resolve) => {
                if (!db.name) return resolve();
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
            });
        });
        await Promise.all(deletePromises);
    });

    // Wait a bit for IndexedDB cleanup to complete
    await page.waitForTimeout(500);
    console.log('Browser storage cleared');
}

/**
 * Login a user and wait for MLS initialization (staged login flow)
 */
async function loginUser(page, user) {
    await page.goto('/#login');
    await page.waitForTimeout(500);
    await page.fill('#email', user.email);
    await page.fill('#password', user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.locator('.home-page')).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });
    await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });
}

async function ensureMessagesUnlocked(page, password) {
  await page.goto('/#messages');
  await page.waitForSelector('.messages-page', { timeout: 15000 });

    const lockedState = page.locator('.messages-locked');
    if (await lockedState.isVisible()) {
        const unlockButton = page.getByRole('button', { name: 'Unlock Messaging' });
        await unlockButton.click();
        await expect(page.getByPlaceholder('Login Password')).toBeVisible({ timeout: 10000 });
        await page.getByPlaceholder('Login Password').fill(password);
        await page.locator('.unlock-modal').getByRole('button', { name: 'Unlock' }).click();
        await expect(page.locator('.unlock-modal')).toBeHidden({ timeout: 15000 });
        await expect(page.locator('.messages-locked')).toBeHidden({ timeout: 15000 });
    }
}

/**
 * Get IndexedDB stats for the granular storage
 */
async function getGranularStorageStats(page) {
    return await page.evaluate(async () => {
        return new Promise((resolve) => {
            // First check if the database exists
            const databases = indexedDB.databases ? indexedDB.databases() : Promise.resolve([]);
            databases.then(dbs => {
                const dbExists = dbs.some(db => db.name === 'intellacc_keystore');
                if (!dbExists) {
                    return resolve({
                        granularEventCount: 0,
                        keystoreRecordCount: 0,
                        stores: [],
                        dbExists: false
                    });
                }

                // Open without version to avoid triggering upgrade
                const request = indexedDB.open('intellacc_keystore');
                request.onerror = () => resolve({ error: 'Failed to open DB' });
                request.onsuccess = () => {
                    const db = request.result;
                    const stores = Array.from(db.objectStoreNames);

                    if (!stores.includes('mls_granular_storage')) {
                        db.close();
                        return resolve({
                            granularEventCount: 0,
                            keystoreRecordCount: 0,
                            stores,
                            dbExists: true
                        });
                    }

                    const tx = db.transaction(['mls_granular_storage', 'device_keystore'], 'readonly');
                    const granularStore = tx.objectStore('mls_granular_storage');
                    const keystoreStore = tx.objectStore('device_keystore');

                    const granularReq = granularStore.count();
                    const keystoreReq = keystoreStore.count();

                    let granularCount = 0;
                    let keystoreCount = 0;

                    granularReq.onsuccess = () => { granularCount = granularReq.result; };
                    keystoreReq.onsuccess = () => { keystoreCount = keystoreReq.result; };

                    tx.oncomplete = () => {
                        db.close();
                        resolve({
                            granularEventCount: granularCount,
                            keystoreRecordCount: keystoreCount,
                            stores,
                            dbExists: true
                        });
                    };
                };
            });
        });
    });
}

/**
 * Get granular event categories and details from IndexedDB
 */
async function getGranularEventDetails(page) {
    return await page.evaluate(async () => {
        return new Promise((resolve) => {
            const request = indexedDB.open('intellacc_keystore');
            request.onerror = () => resolve({ categories: [], records: [] });
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('mls_granular_storage')) {
                    db.close();
                    return resolve({ categories: [], records: [] });
                }
                const tx = db.transaction('mls_granular_storage', 'readonly');
                const store = tx.objectStore('mls_granular_storage');
                const req = store.getAll();

                req.onsuccess = () => {
                    const records = req.result || [];
                    const categories = [...new Set(records.map(r => r.category))];
                    const details = records.map(r => ({
                        id: r.id,
                        category: r.category,
                        hasEncryptedValue: !!r.encryptedValue
                    }));
                    db.close();
                    resolve({ categories, recordCount: records.length, details });
                };
                req.onerror = () => {
                    db.close();
                    resolve({ categories: [], records: [] });
                };
            };
        });
    });
}

/**
 * Reset server-side state for test users via shell script
 */
async function resetServerState() {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
        exec('./tests/e2e/reset-test-users.sh', (error, stdout, stderr) => {
            if (error) {
                console.warn('Reset script warning:', stderr);
            }
            console.log('Server state reset:', stdout.includes('Reset complete'));
            resolve();
        });
    });
}

test.describe.skip('LEGACY: Granular MLS Persistence (quarantined)', () => {

    test.beforeAll(async () => {
        // Reset server state once before all tests in this file
        await resetServerState();
    });

    test('Granular storage is created on login', async ({ page }) => {
        // This is the primary test for granular persistence
        await clearBrowserStorage(page);
        console.log('Test: Granular storage is created on login');

        // Verify empty state before login
        const beforeStats = await getGranularStorageStats(page);
        console.log('Before login:', beforeStats);
        expect(beforeStats.dbExists).toBe(false);

        // Login
        await loginUser(page, USER1);

        // Verify granular storage was created
        const afterStats = await getGranularStorageStats(page);
        console.log('After login:', afterStats);

        // Should have:
        // - Database created with correct stores
        // - At least 1 granular event (key_package)
        // - 1 keystore record (identity)
        expect(afterStats.dbExists).toBe(true);
        expect(afterStats.stores).toContain('mls_granular_storage');
        expect(afterStats.stores).toContain('device_keystore');
        expect(afterStats.granularEventCount).toBeGreaterThan(0);
        expect(afterStats.keystoreRecordCount).toBe(1);

        // Check event categories
        const eventDetails = await getGranularEventDetails(page);
        console.log('Granular events:', eventDetails);
        expect(eventDetails.categories).toContain('key_package');

        // Verify each record has encrypted data
        for (const detail of eventDetails.details) {
            expect(detail.hasEncryptedValue).toBe(true);
        }
    });

    test('Granular events persist across page reload', async ({ page }) => {
        console.log('Test: Granular events persist across page reload');

        // Reset server state to ensure fresh key package creation
        await resetServerState();

        // Clear browser and login fresh
        await clearBrowserStorage(page);
        await loginUser(page, USER1);

        // Verify granular events were created
        const beforeReload = await getGranularStorageStats(page);
        console.log('Before reload:', beforeReload);
        expect(beforeReload.granularEventCount).toBeGreaterThan(0);
        expect(beforeReload.keystoreRecordCount).toBe(1);

        // Reload page (simulates browser restart - IndexedDB should persist)
        await page.reload();
        await page.waitForTimeout(2000);

        // Verify data persists after reload
        const afterReload = await getGranularStorageStats(page);
        console.log('After reload:', afterReload);

        expect(afterReload.granularEventCount).toBe(beforeReload.granularEventCount);
        expect(afterReload.keystoreRecordCount).toBe(beforeReload.keystoreRecordCount);
    });

    test('Memory is cleared on logout simulation', async ({ page }) => {
        // Reset server state to ensure fresh key package creation
        await resetServerState();

        await clearBrowserStorage(page);
        console.log('Test: Memory is cleared on logout');

        // Login first
        await loginUser(page, USER1);

        await ensureMessagesUnlocked(page, USER1.password);

        // Check MLS client exists
        const beforeLogout = await page.evaluate(() => ({
            clientExists: !!window.coreCryptoClient?.client,
            identityName: window.coreCryptoClient?.identityName,
            hasMessageStore: !!window.messagingStore
        }));
        console.log('Before logout:', beforeLogout);
        expect(beforeLogout.clientExists).toBe(true);

        // Simulate logout: wipe memory AND capture result immediately
        // Note: Messages page has reactive code that re-inits MLS, so we check within the same evaluate
        const wipeResult = await page.evaluate(() => {
            try {
                const cc = window.coreCryptoClient;
                if (!cc) return { error: 'coreCryptoClient not found' };

                // Capture state before wipe
                const clientBefore = !!cc.client;
                const identityBefore = cc.identityName;

                // Call wipeMemory
                cc.wipeMemory();

                // Also clear messaging store
                if (window.messagingStore?.clearCache) {
                    window.messagingStore.clearCache();
                }

                // Capture state immediately after wipe (before any reactive re-init)
                const clientAfter = !!cc.client;
                const identityAfter = cc.identityName;

                return {
                    success: true,
                    clientBefore,
                    identityBefore,
                    clientAfter,
                    identityAfter
                };
            } catch (e) {
                return { error: e.message };
            }
        });
        console.log('Wipe result:', wipeResult);

        // The test verifies wipeMemory() correctly clears the client
        // Note: We don't check in a separate evaluate because Messages page
        // has reactive code that re-initializes MLS when client is null
        expect(wipeResult.success).toBe(true);
        expect(wipeResult.clientBefore).toBe(true);
        expect(wipeResult.clientAfter).toBe(false);
        expect(wipeResult.identityAfter).toBeFalsy();
    });

});
