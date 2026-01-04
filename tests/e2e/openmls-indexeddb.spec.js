const { test, expect } = require('@playwright/test');

test('persists OpenMLS state to Encrypted Keystore', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const vaultService = (await import('/src/services/vaultService.js')).default;
    const core = (await import('/src/services/mls/coreCryptoClient.js')).default;

    // Simulate login flow
    const userId = 999;
    const password = 'test-password-123';
    
    // Set userId in store
    const vaultStore = (await import('/src/stores/vaultStore.js')).default;
    vaultStore.setUserId(userId);

    // Bootstrap MLS (creates identity in memory)
    await core.initialize();
    await core.ensureMlsBootstrap(String(userId));

    // Setup Keystore (encrypts and saves state)
    // Note: We need to wipe first to ensure clean test state
    await vaultService.panicWipe();
    vaultStore.setUserId(userId); // Re-set after wipe
    
    await vaultService.setupKeystoreWithPassword(password);
    const deviceId = vaultService.getDeviceId();

    // Check IndexedDB
    const record = await new Promise((resolve, reject) => {
      const request = indexedDB.open('intellacc_keystore', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('device_keystore')) {
            resolve(null);
            return;
        }
        const tx = db.transaction(['device_keystore'], 'readonly');
        const store = tx.objectStore('device_keystore');
        const getRequest = store.get(`device_keystore_${deviceId}`);
        getRequest.onerror = () => reject(getRequest.error);
        getRequest.onsuccess = () => resolve(getRequest.result);
      };
    });

    const encryptedState = record && record.encryptedDeviceState;
    
    return {
      hasRecord: !!record,
      hasEncryptedState: !!(encryptedState && encryptedState.ciphertext),
      version: record ? record.version : 0
    };
  });

  expect(result.hasRecord).toBeTruthy();
  expect(result.hasEncryptedState).toBeTruthy();
  expect(result.version).toBe(2);
});
