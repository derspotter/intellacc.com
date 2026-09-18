const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  const token = `e30.${Buffer.from(JSON.stringify({ userId: 42, username: 'fixture', exp: 9999999999 })).toString('base64url')}.test`;
  await page.addInitScript((value) => localStorage.setItem('token', value), token);
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('direct')) return route.fulfill({ json: [
      { id: 'chat-a', group_id: 'chat-a', other_user_id: 43, other_username: 'Alice' },
      { id: 'chat-b', group_id: 'chat-b', other_user_id: 44, other_username: 'Bob' }
    ] });
    return route.fulfill({ json: { id: 42, userId: 42, username: 'fixture' } });
  });
  await page.goto('/test/message-history.html');
  await page.waitForFunction(() => !!window.historyFixture);
});

test('v11 migration pages tied timestamps, isolates devices/groups and bounds real decrypts', async ({ page }) => {
  expect(await page.evaluate(() => historyFixture.seed())).toBe(12);
  await page.evaluate(() => historyFixture.open());
  const first = await page.evaluate(() => ({ state: historyFixture.state(), stats: historyFixture.stats() }));
  expect(first.state.messages.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 76));
  expect(first.stats.decrypts).toBe(50);
  expect(first.stats.peak).toBeLessThanOrEqual(4);
  await page.evaluate(() => Promise.all([historyFixture.older(), historyFixture.older()]));
  expect((await page.evaluate(() => historyFixture.state())).messages).toHaveLength(100);
  await page.evaluate(() => historyFixture.older());
  const final = await page.evaluate(() => historyFixture.state());
  expect(final.messages.map((row) => row.id)).toEqual(Array.from({ length: 125 }, (_, i) => i + 1));
  expect(final.hasMore).toBe(false);
  expect((await page.evaluate(() => historyFixture.stats())).decrypts).toBe(125);
});

test('new messages decrypt once, edits/deletes update only their row and hidden edits stay paged', async ({ page }) => {
  await page.evaluate(async () => { await historyFixture.seed(); await historyFixture.open(); historyFixture.resetStats(); });
  await page.evaluate(() => historyFixture.insert(200));
  expect((await page.evaluate(() => historyFixture.stats())).decrypts).toBe(1);
  await page.evaluate(() => historyFixture.edit(100, 'Edited once'));
  await page.evaluate(() => historyFixture.remove(110));
  await page.evaluate(() => historyFixture.edit(1, 'Older edit'));
  const state = await page.evaluate(() => historyFixture.state());
  expect(state.messages.find((row) => row.id === 100).plaintext).toBe('Edited once');
  expect(state.messages.find((row) => row.id === 110)).toMatchObject({ plaintext: '', deleted: true });
  expect(state.messages.some((row) => row.id === 1)).toBe(false);
  expect((await page.evaluate(() => historyFixture.stats())).decrypts).toBe(6);
  await page.evaluate(async () => { await historyFixture.older(); await historyFixture.older(); });
  expect((await page.evaluate(() => historyFixture.state())).messages.find((row) => row.id === 1).plaintext).toBe('Older edit');
});

test('expiry, corrupt records and sender checks preserve usable history', async ({ page }) => {
  await page.evaluate(async () => {
    await historyFixture.seed({ count: 2, legacy: false });
    await historyFixture.insert(3, { expiresAt: Date.now() - 1 });
    await historyFixture.insert(4, { expiresAt: Date.now() + 1200 });
    await historyFixture.open();
  });
  expect((await page.evaluate(() => historyFixture.state())).messages.map((row) => row.id)).toEqual([1, 2, 4]);
  await expect.poll(() => page.evaluate(() => historyFixture.state().messages.map((row) => row.id))).toEqual([1, 2]);
  expect(await page.evaluate(() => historyFixture.vault.applyMessageEdit('chat-a', 1, 'forged', { requireSenderId: '99' }))).toEqual({ ok: false, reason: 'sender_mismatch' });
  await page.evaluate(async () => {
    const vault = historyFixture.vault;
    const record = await vault._findMessageRecord('chat-a', 2);
    record.encryptedData.ciphertext = [0];
    await new Promise((resolve) => {
      const tx = vault.db.transaction('encrypted_messages', 'readwrite');
      tx.objectStore('encrypted_messages').put(record);
      tx.oncomplete = resolve;
    });
    await historyFixture.select('chat-b');
    await historyFixture.select('chat-a');
  });
  expect((await page.evaluate(() => historyFixture.state())).messages.map((row) => row.id)).toEqual([1]);
});

test('in-flight decrypts cannot repopulate history after locking, switching or disposal', async ({ page }) => {
  await page.evaluate(async () => { await historyFixture.seed(); historyFixture.pause(); void historyFixture.open(); });
  await expect.poll(() => page.evaluate(() => historyFixture.stats().active)).toBe(4);
  await page.evaluate(() => historyFixture.lock());
  expect((await page.evaluate(() => historyFixture.state())).messages).toEqual([]);
  await page.evaluate(() => { historyFixture.unlock(); historyFixture.resume(); });
  await expect.poll(() => page.evaluate(() => historyFixture.stats().active)).toBe(0);
  expect((await page.evaluate(() => historyFixture.state())).messages).toEqual([]);
  await page.evaluate(() => { historyFixture.pause(); void historyFixture.select('chat-a'); });
  await expect.poll(() => page.evaluate(() => historyFixture.stats().active)).toBe(4);
  await page.evaluate(() => { void historyFixture.select('chat-b'); historyFixture.resume(); });
  await expect.poll(() => page.evaluate(() => historyFixture.state().messages.map((row) => row.id))).toEqual([127]);
  await page.evaluate(() => { historyFixture.pause(); void historyFixture.select('chat-a'); });
  await expect.poll(() => page.evaluate(() => historyFixture.stats().active)).toBe(4);
  await page.evaluate(() => { historyFixture.dispose(); historyFixture.resume(); });
  await expect.poll(() => page.evaluate(() => historyFixture.stats().active)).toBe(0);
  expect((await page.evaluate(() => historyFixture.state())).messages).toEqual([]);
});

for (const skin of ['terminal', 'full']) {
  test(`${skin} chat loads older messages, receives edits and clears on lock`, async ({ page }) => {
    await page.evaluate(async (skin) => { await historyFixture.seed(); historyFixture.mount(skin); }, skin);
    await page.getByText(/^Alice$/i).first().click();
    await expect(page.getByText('Message 125', { exact: true })).toBeVisible();
    await expect(page.getByText('Message 1', { exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => historyFixture.stats().decrypts)).toBe(50);
    await page.getByText(/^Alice$/i).first().click();
    await expect(page.getByText('Message 125', { exact: true })).toBeVisible();
    expect((await page.evaluate(() => historyFixture.stats())).decrypts).toBe(50);
    const anchorTop = await page.getByText('Message 76', { exact: true }).evaluate((node) => node.getBoundingClientRect().top);
    await page.getByRole('button', { name: /load older messages/i }).click();
    await expect(page.getByText('Message 26', { exact: true })).toBeVisible();
    if (skin === 'full') {
      const newTop = await page.getByText('Message 76', { exact: true }).evaluate((node) => node.getBoundingClientRect().top);
      expect(Math.abs(newTop - anchorTop)).toBeLessThanOrEqual(2);
    }
    await page.evaluate(() => historyFixture.edit(100, 'UI edited'));
    await expect(page.getByText('UI edited', { exact: true })).toBeVisible();
    await page.evaluate(() => historyFixture.remove(100));
    await expect(page.getByText('Message deleted', { exact: true })).toBeVisible();
    const composer = page.locator('textarea').last();
    await composer.fill('Sent without duplication');
    await composer.press('Enter');
    await expect(page.getByText('Sent without duplication', { exact: true })).toHaveCount(1);
    await page.evaluate(() => historyFixture.insert(9001, { plaintext: 'Next incoming message' }));
    await expect(page.getByText('Next incoming message', { exact: true })).toBeVisible();
    await expect(page.getByText('Sent without duplication', { exact: true })).toHaveCount(1);
    await page.evaluate(() => historyFixture.lock());
    await expect(page.getByText('Message 125', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /load older messages/i })).toHaveCount(0);
  });

  test(`${skin} reconciles two sends while history decryption is delayed`, async ({ page }) => {
    await page.evaluate(async (skin) => { await historyFixture.seed({ count: 1 }); historyFixture.mount(skin); }, skin);
    await page.getByText(/^Alice$/i).first().click();
    await expect(page.getByText('Message 1', { exact: true })).toBeVisible();
    await page.evaluate(() => historyFixture.pause());
    const composer = page.locator('textarea').last();
    await composer.fill('First quick send');
    await composer.press('Enter');
    await expect.poll(() => page.evaluate(() => historyFixture.stats().active)).toBe(1);
    await composer.fill('Second quick send');
    await composer.press('Enter');
    await expect(page.getByText('Second quick send', { exact: true })).toHaveCount(1);
    await page.evaluate(() => historyFixture.resume());
    await expect.poll(() => page.evaluate(() => historyFixture.stats().decrypts)).toBe(3);
    await expect(page.getByText('First quick send', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Second quick send', { exact: true })).toHaveCount(1);
  });
}

test('locking between MLS receive and local persistence leaves the relay ID retryable', async ({ page }) => {
  await page.evaluate(async () => {
    await historyFixture.seed({ count: 0, legacy: false });
    const core = historyFixture.core;
    core.client = {};
    core.identityName = '42';
    // The real receive handler and encrypted persistence are exercised; only
    // the MLS wire decrypt/AAD boundary is stubbed for this ordering regression.
    core.decryptMessage = () => ({ plaintext: 'Retried receive', epoch: 1, aadBytes: new Uint8Array() });
    core.validateAad = () => ({ valid: true });
    core._messageExpiryFor = () => new Promise((resolve) => { window.finishExpiry = resolve; });
    window.relayMessage = { id: '8000', group_id: 'chat-a', data: [], content_type: 'application', sender_id: 'remote', sender_user_id: '43' };
    window.receiveResult = core.handleIncomingMessage(relayMessage).then(() => 'stored', (error) => error.message);
  });
  await page.waitForFunction(() => !!window.finishExpiry);
  await page.evaluate(async () => { await historyFixture.lock(); finishExpiry(null); });
  expect(await page.evaluate(() => receiveResult)).toBe('Vault locked');
  expect(await page.evaluate(() => historyFixture.core.processedMessageIds.has('8000'))).toBe(false);
  await page.evaluate(async () => {
    historyFixture.unlock();
    historyFixture.core.client = {};
    historyFixture.core._messageExpiryFor = async () => null;
    await historyFixture.core.handleIncomingMessage(relayMessage);
    await historyFixture.open();
  });
  expect((await page.evaluate(() => historyFixture.state())).messages.map((row) => row.plaintext)).toEqual(['Retried receive']);
  await expect.poll(() => page.evaluate(() => historyFixture.vault.getRecentProcessedMessages())).toEqual(['8000']);
});

test('commits during paging are retained and a device change clears the decrypted window', async ({ page }) => {
  await page.evaluate(async () => { await historyFixture.seed(); historyFixture.pause(); void historyFixture.open(); });
  await expect.poll(() => page.evaluate(() => historyFixture.stats().active)).toBe(4);
  await page.evaluate(() => { void historyFixture.insert(500, { plaintext: 'Arrived during open' }); });
  await page.evaluate(() => historyFixture.resume());
  await expect.poll(() => page.evaluate(() => historyFixture.state().messages.length)).toBe(51);
  await page.evaluate(() => historyFixture.vault.setDeviceId('other-device'));
  expect((await page.evaluate(() => historyFixture.state())).messages).toEqual([]);
  await page.evaluate(() => historyFixture.select('chat-a'));
  expect((await page.evaluate(() => historyFixture.state())).messages.map((row) => row.id)).toEqual([126]);
});

test('real MLS receive can be redelivered after locking during AES-GCM persistence', async ({ page }) => {
  await page.evaluate(async () => {
    await historyFixture.seed({ count: 0, legacy: false });
    window.realRelayMessage = await historyFixture.prepareMlsReceive();
    window.originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = async (...args) => {
      await new Promise((resolve) => { window.finishEncrypt = resolve; });
      return originalEncrypt(...args);
    };
    window.realReceiveResult = historyFixture.core.handleIncomingMessage(realRelayMessage)
      .then(() => 'stored', (error) => error.message);
  });
  await page.waitForFunction(() => !!window.finishEncrypt);
  await page.evaluate(async () => { await historyFixture.lock(); finishEncrypt(); });
  expect(await page.evaluate(() => realReceiveResult)).toBe('Vault locked');
  expect(await page.evaluate(() => historyFixture.core.processedMessageIds.has('8100'))).toBe(false);
  await page.evaluate(async () => {
    crypto.subtle.encrypt = originalEncrypt;
    historyFixture.unlock();
    await historyFixture.restoreMlsReceiver();
    await historyFixture.core.handleIncomingMessage(realRelayMessage);
    await historyFixture.open('dm_42_43');
  });
  expect((await page.evaluate(() => historyFixture.state())).messages.map((row) => row.plaintext)).toEqual(['Real MLS retry']);
  await expect.poll(() => page.evaluate(() => historyFixture.vault.getRecentProcessedMessages())).toEqual(['8100']);
});

test('an expired last page stays bounded and its cursor still reaches older messages', async ({ page }) => {
  await page.evaluate(async () => {
    await historyFixture.seed({ count: 2, legacy: false });
    for (let id = 3; id <= 52; id++) await historyFixture.insert(id, { expiresAt: Date.now() - 1 });
    await historyFixture.open();
  });
  expect((await page.evaluate(() => historyFixture.state())).messages).toEqual([]);
  expect((await page.evaluate(() => historyFixture.state())).hasMore).toBe(true);
  expect((await page.evaluate(() => historyFixture.stats())).decrypts).toBe(50);
  await page.evaluate(() => historyFixture.older());
  expect((await page.evaluate(() => historyFixture.state())).messages.map((row) => row.id)).toEqual([1, 2]);
});

test('another same-origin view without a history subscriber broadcasts identifiers only', async ({ page }) => {
  await page.evaluate(async () => { await historyFixture.seed(); await historyFixture.open(); historyFixture.resetStats(); });
  await page.evaluate(async () => {
    const iframe = document.createElement('iframe');
    iframe.src = '/test/message-history.html';
    document.body.append(iframe);
    await new Promise((resolve) => { iframe.onload = resolve; });
    const remote = iframe.contentWindow.historyFixture;
    remote.vault.compositeKey = historyFixture.vault.compositeKey;
    remote.vault.setDeviceId('fixture-device');
    await remote.vault.initDB();
    window.broadcasts = [];
    window.observer = new BroadcastChannel('intellacc-message-history');
    observer.onmessage = ({ data }) => broadcasts.push(data);
    await remote.insert(700, { plaintext: 'Another tab' });
  });
  await expect.poll(() => page.evaluate(() => historyFixture.state().messages.at(-1).plaintext)).toBe('Another tab');
  expect((await page.evaluate(() => historyFixture.stats())).decrypts).toBe(1);
  await expect.poll(() => page.evaluate(() => broadcasts.length)).toBe(1);
  expect(await page.evaluate(() => broadcasts[0])).toEqual({ deviceId: 'fixture-device', kind: 'insert', groupId: 'chat-a', messageId: 700 });
});

test('a legacy tab blocking the database upgrade gives an actionable error and can recover', async ({ page }) => {
  await page.evaluate(() => new Promise((resolve) => {
    const request = indexedDB.open('intellacc_keystore', 11);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('encrypted_messages', { keyPath: 'id', autoIncrement: true });
      for (const name of ['groupId', 'deviceId', 'timestamp']) store.createIndex(name, name);
    };
    request.onsuccess = () => { window.legacyDb = request.result; resolve(); };
  }));
  const error = await page.evaluate(async () => {
    try { await historyFixture.seed({ legacy: false, count: 0 }); }
    catch (error) { return error.message; }
  });
  expect(error).toContain('Close other Intellacc tabs');
  await page.evaluate(async () => { legacyDb.close(); await historyFixture.vault.initDB(); await historyFixture.open(); });
  expect((await page.evaluate(() => historyFixture.state())).messages).toEqual([]);
  expect(await page.evaluate(() => historyFixture.vault.db.version)).toBe(12);
});
