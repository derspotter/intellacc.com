// Safety numbers / TOFU fingerprint E2E (Solid).
//
// The Solid client records contact signature-key fingerprints in the
// encrypted vault on first contact (Trust On First Use), supports explicit
// out-of-band verification, and flags fingerprint changes as potential MITM.
// There is currently no fingerprint UI in the Solid skins (warnings surface
// in messagingStore only), so this spec asserts the client/vault behavior
// through the real messaging flow.

const { test, expect } = require('@playwright/test');
const {
  apiFetch,
  createUser,
  provisionTier,
  provisionTopics,
  loginOnSolid,
  provisionMessaging,
  waitWithSync,
  cleanupUsers
} = require('./helpers/solidMessaging');

async function getContactFingerprint(page, contactUserId) {
  return page.evaluate(async (contactId) => {
    try {
      const vault = await window.coreCryptoClient.getVaultService();
      const record = await vault.getContactFingerprint(contactId);
      return record || { status: 'not_found' };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  }, contactUserId);
}

test.describe('Safety numbers / TOFU fingerprints E2E', () => {
  test('fingerprints are recorded on first contact, verifiable, and change detection fires', async ({ browser }) => {
    test.setTimeout(240000);

    const alice = await createUser('sn_alice');
    const bob = await createUser('sn_bob');
    provisionTier(alice);
    provisionTier(bob);
    await provisionTopics(alice);
    await provisionTopics(bob);

    // Bob follows Alice so the welcome auto-accepts (TOFU capture is the
    // subject here, not the request flow — that's key-rotation-inspection).
    const follow = await apiFetch(`/api/users/${alice.id}/follow`, { method: 'POST', token: bob.token });
    if (!follow.response.ok) {
      throw new Error(`Bob could not follow Alice (${follow.response.status}): ${follow.text}`);
    }

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await loginOnSolid(pageA, alice);
      await provisionMessaging(pageA, alice);
      await loginOnSolid(pageB, bob);
      await provisionMessaging(pageB, bob);

      // Real DM: invite -> welcome -> message -> reply.
      await pageA.getByRole('button', { name: '+ New' }).click();
      await pageA.fill('input[placeholder="Start by user id"]', String(bob.id));
      await pageA.locator('.new-conversation-form button[type="submit"]').click();
      await expect(pageA.locator('.conversation-item').first()).toBeVisible({ timeout: 45000 });

      const fromAlice = `tofu hello ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', fromAlice);
      await pageA.locator('button.send-button').click();

      await waitWithSync(pageB, pageB.locator('.conversation-item'), { timeout: 90000 });
      await pageB.locator('.conversation-item').first().click();
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: fromAlice }),
        { timeout: 90000, reopenConversation: true }
      );

      // Bob's reply gives Alice a message from Bob to fingerprint.
      const fromBob = `tofu reply ${Date.now()}`;
      await pageB.fill('textarea.message-textarea', fromBob);
      await pageB.locator('button.send-button').click();
      await waitWithSync(
        pageA,
        pageA.locator('.message-item.received .message-text', { hasText: fromBob }),
        { timeout: 90000, reopenConversation: true }
      );

      // TOFU: Bob recorded Alice's fingerprint from the welcome/messages.
      const bobViewOfAlice = await getContactFingerprint(pageB, alice.id);
      expect(bobViewOfAlice.fingerprint, `Bob's record of Alice: ${JSON.stringify(bobViewOfAlice)}`).toBeTruthy();
      expect(bobViewOfAlice.fingerprint).toMatch(/^[a-f0-9]+$/i);
      expect(bobViewOfAlice.status).toBe('unverified');
      expect(bobViewOfAlice.firstSeenAt).toBeTruthy();

      // Alice recorded Bob's fingerprint from his messages.
      const aliceViewOfBob = await getContactFingerprint(pageA, bob.id);
      expect(aliceViewOfBob.fingerprint, `Alice's record of Bob: ${JSON.stringify(aliceViewOfBob)}`).toBeTruthy();
      expect(aliceViewOfBob.status).toBe('unverified');

      // Out-of-band verification marks the contact verified; unverify resets.
      await pageB.evaluate((contactId) => window.coreCryptoClient.verifyContact(contactId), alice.id);
      const verified = await getContactFingerprint(pageB, alice.id);
      expect(verified.status).toBe('verified');
      expect(verified.verifiedAt).toBeTruthy();

      await pageB.evaluate((contactId) => window.coreCryptoClient.unverifyContact(contactId), alice.id);
      const unverified = await getContactFingerprint(pageB, alice.id);
      expect(unverified.status).toBe('unverified');

      // MITM detection: a different fingerprint for a known contact is
      // flagged as changed, keeps the previous fingerprint, and resets
      // verification.
      await pageB.evaluate((contactId) => window.coreCryptoClient.verifyContact(contactId), alice.id);
      const changeResult = await pageB.evaluate(
        (contactId) => window.coreCryptoClient.recordContactFingerprint(contactId, 'deadbeef'.repeat(8)),
        alice.id
      );
      expect(changeResult.changed, `change detection: ${JSON.stringify(changeResult)}`).toBe(true);
      expect(changeResult.previousFingerprint).toBe(bobViewOfAlice.fingerprint);

      const afterChange = await getContactFingerprint(pageB, alice.id);
      expect(afterChange.status).toBe('changed');
      expect(afterChange.previousFingerprint).toBe(bobViewOfAlice.fingerprint);
      expect(afterChange.verifiedAt).toBeFalsy();

      // Re-seeing the same (new) fingerprint is not another change.
      const stable = await pageB.evaluate(
        (contactId) => window.coreCryptoClient.recordContactFingerprint(contactId, 'deadbeef'.repeat(8)),
        alice.id
      );
      expect(stable).toMatchObject({ isNew: false, changed: false });
    } finally {
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
      cleanupUsers([alice, bob]);
    }
  });
});
