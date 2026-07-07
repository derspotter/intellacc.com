// Solid-to-Solid encrypted DM exchange over the MLS relay.
//
// Replaces the messaging delivery coverage lost when the legacy VanJS specs
// were removed with the 2026-06-11 cutover. Drives the real UI flow on two
// browser contexts: invite -> welcome -> message -> reply.
//
// Requirements:
// - Solid frontend reachable at SOLID_URL (default http://127.0.0.1:4174,
//   e.g. `docker compose -p solid-local -f docker-compose.solid-local.yml up -d`).
//   The Vite server proxies /api and /socket.io to the backend, so no separate
//   backend URL is needed by default.
// - Database container reachable via `docker exec` for test-user provisioning.

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

test.describe('Solid messaging E2E', () => {
  test('two users can exchange encrypted direct messages', async ({ browser }) => {
    test.setTimeout(240000);

    const alice = await createUser('alice');
    const bob = await createUser('bob');
    provisionTier(alice);
    provisionTier(bob);
    // Seed topics so the blocking onboarding gate (VanApp checkTopics ->
    // TopicPicker) never hijacks #messages mid-test — see provisionTopics.
    await provisionTopics(alice);
    await provisionTopics(bob);

    // Welcomes auto-accept only when the receiver follows the sender;
    // otherwise they park as message requests awaiting UI confirmation.
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

      // Alice opens a DM with Bob by user id (real MLS invite + welcome).
      await pageA.getByRole('button', { name: '+ New' }).click();
      await pageA.fill('input[placeholder="Start by user id"]', String(bob.id));
      await pageA.locator('.new-conversation-form button[type="submit"]').click();
      await expect(pageA.locator('.conversation-item').first()).toBeVisible({ timeout: 45000 });
      await expect(pageA.locator('.encryption-status')).toContainText('MLS conversation', { timeout: 30000 });

      // Alice sends the first message.
      const messageFromAlice = `hello from alice ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', messageFromAlice);
      await pageA.locator('button.send-button').click();
      await expect(pageA.locator('.message-item.sent .message-text').last())
        .toHaveText(messageFromAlice, { timeout: 30000 });

      // Bob's client processes the welcome; the conversation appears.
      await waitWithSync(pageB, pageB.locator('.conversation-item'), { timeout: 90000 });
      await pageB.locator('.conversation-item').first().click();
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: messageFromAlice }),
        { timeout: 90000, reopenConversation: true }
      );

      // Bob replies on the established group.
      const messageFromBob = `hi alice, bob here ${Date.now()}`;
      await pageB.fill('textarea.message-textarea', messageFromBob);
      await pageB.locator('button.send-button').click();
      await expect(pageB.locator('.message-item.sent .message-text').last())
        .toHaveText(messageFromBob, { timeout: 30000 });

      // Alice receives the reply.
      await waitWithSync(
        pageA,
        pageA.locator('.message-item.received .message-text', { hasText: messageFromBob }),
        { timeout: 90000, reopenConversation: true }
      );

      // Read receipts: Bob opening the conversation sent one; Alice's sent
      // message shows the Read marker once the receipt control message lands.
      await waitWithSync(
        pageA,
        pageA.locator('.message-item.sent .message-read-indicator'),
        { timeout: 90000, reopenConversation: true }
      );

      // Edit: Alice edits her message; both sides show new text + (edited).
      const editedText = `edited by alice ${Date.now()}`;
      await pageA.locator('.message-item.sent .message-action-btn', { hasText: 'Edit' }).first().click();
      await pageA.fill('.message-edit-form .message-textarea', editedText);
      await pageA.locator('.message-edit-form button[type="submit"]').click();
      await expect(pageA.locator('.message-item.sent .message-text', { hasText: editedText }))
        .toBeVisible({ timeout: 15000 });
      await expect(pageA.locator('.message-item.sent .message-edited').first()).toBeVisible();
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: editedText }),
        { timeout: 90000, reopenConversation: true }
      );
      await expect(pageB.locator('.message-item.received .message-edited').first()).toBeVisible();

      // Delete: Bob tombstones his reply (two-step inline confirm); both
      // sides render the tombstone.
      await pageB.locator('.message-item.sent .message-action-btn', { hasText: 'Delete' }).first().click();
      await pageB.locator('.message-item.sent .message-action-btn', { hasText: 'Confirm delete' }).first().click();
      await expect(pageB.locator('.message-item.sent.deleted .message-text'))
        .toHaveText('Message deleted', { timeout: 15000 });
      await waitWithSync(
        pageA,
        pageA.locator('.message-item.received.deleted .message-text'),
        { timeout: 90000, reopenConversation: true }
      );

      // Disappearing messages: set a short TTL via the client API (the UI
      // select offers minutes and up; 5s keeps the test fast), confirm the
      // encrypted control message propagates, then watch a message expire
      // from both vaults.
      const dmGroupId = `dm_${Math.min(alice.id, bob.id)}_${Math.max(alice.id, bob.id)}`;
      await pageA.evaluate(
        (groupId) => window.coreCryptoClient.setDisappearingTimer(groupId, 5),
        dmGroupId
      );
      await expect
        .poll(async () => {
          await pageB.evaluate(async () => {
            try { await window.coreCryptoClient.syncMessages(); } catch {}
          });
          return pageB.evaluate(
            (groupId) => window.coreCryptoClient.getDisappearingTimer(groupId),
            dmGroupId
          );
        }, { timeout: 60000, message: 'disappearing TTL propagated to Bob' })
        .toBe(5);

      const vanishingText = `now you see me ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', vanishingText);
      await pageA.locator('button.send-button').click();
      await expect(pageA.locator('.message-item.sent .message-text', { hasText: vanishingText }))
        .toBeVisible({ timeout: 30000 });
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: vanishingText }),
        { timeout: 90000, reopenConversation: true }
      );

      // After the TTL elapses, reads purge the message on both sides.
      await pageA.waitForTimeout(6000);
      for (const page of [pageA, pageB]) {
        await expect
          .poll(async () => {
            await page.locator('.conversation-item').first().click();
            await page.waitForTimeout(500);
            return page.locator('.message-item .message-text', { hasText: vanishingText }).count();
          }, { timeout: 30000, message: 'expired message purged' })
          .toBe(0);
      }
    } finally {
      // Guard each teardown step: a harness-level context-close race
      // ("Target page, context or browser has been closed") must not red an
      // otherwise-passing run, nor skip the later steps and leak test users.
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
      cleanupUsers([alice, bob]);
    }
  });
});
