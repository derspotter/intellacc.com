const { test, expect } = require('@playwright/test');

test('persists OpenMLS state to IndexedDB', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const core = (await import('/src/services/mls/coreCryptoClient.js')).default;

    await core.initialize();
    await core.clearState();
    await core.ensureMlsBootstrap('e2e-user');

    const record = await new Promise((resolve, reject) => {
      const request = indexedDB.open('openmls_storage', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['state'], 'readonly');
        const store = tx.objectStore('state');
        const getRequest = store.get('identity_e2e-user');
        getRequest.onerror = () => reject(getRequest.error);
        getRequest.onsuccess = () => resolve(getRequest.result);
      };
    });

    const storageState = record && record.storageState;
    const storageBytes = storageState instanceof Uint8Array
      ? storageState.byteLength
      : storageState && storageState.byteLength
        ? storageState.byteLength
        : Array.isArray(storageState)
          ? storageState.length
          : 0;

    return {
      hasRecord: !!record,
      hasCredential: !!(record && record.credential),
      hasBundle: !!(record && record.bundle),
      hasSignatureKey: !!(record && record.signatureKey),
      storageBytes
    };
  });

  expect(result.hasRecord).toBeTruthy();
  expect(result.hasCredential).toBeTruthy();
  expect(result.hasBundle).toBeTruthy();
  expect(result.hasSignatureKey).toBeTruthy();
  expect(result.storageBytes).toBeGreaterThan(0);
});
